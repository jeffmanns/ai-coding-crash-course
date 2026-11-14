import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import { getInstructorAnalytics } from "./instructorAnalyticsService";
import { calculateProgress } from "./progressService";
import { createTeamPurchase } from "./purchaseService";
import { redeemCoupon } from "./couponService";

function insertUser(email: string, role: schema.UserRole) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role })
    .returning()
    .get();
}

const insertInstructor = (email: string) =>
  insertUser(email, schema.UserRole.Instructor);
const insertStudent = (email: string) =>
  insertUser(email, schema.UserRole.Student);

function insertCourse(
  slug: string,
  instructorId: number,
  status: schema.CourseStatus = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: slug,
      salesCopy: slug,
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function enroll(userId: number, courseId: number, completedAt: string | null = null) {
  testDb.insert(schema.enrollments).values({ userId, courseId, completedAt }).run();
}

function insertLessons(courseId: number, count: number) {
  const module = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();
  return Array.from({ length: count }, (_, i) =>
    testDb
      .insert(schema.lessons)
      .values({ moduleId: module.id, title: `Lesson ${i + 1}`, position: i + 1 })
      .returning()
      .get()
  );
}

function recordProgress(
  userId: number,
  lessonId: number,
  status: schema.LessonProgressStatus = schema.LessonProgressStatus.Completed
) {
  testDb.insert(schema.lessonProgress).values({ userId, lessonId, status }).run();
}

function insertPurchase(userId: number, courseId: number, amountPaid: number) {
  testDb.insert(schema.purchases).values({ userId, courseId, amountPaid }).run();
}

const COMPLETED_AT = "2026-01-01T00:00:00.000Z";

function courseById(result: ReturnType<typeof getInstructorAnalytics>, id: number) {
  const course = result.courses.find((c) => c.id === id);
  if (!course) throw new Error(`course ${id} not in result`);
  return course;
}

describe("getInstructorAnalytics", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("returns only the given instructor's courses", () => {
    const other = insertInstructor("other@example.com");
    const othersCourse = insertCourse("others-course", other.id);
    enroll(base.user.id, othersCourse.id);

    const result = getInstructorAnalytics(base.instructor.id);

    expect(result.courses.map((c) => c.id)).toEqual([base.course.id]);
    expect(result.totals.uniqueStudents).toBe(0);
  });

  it("excludes drafts and includes published and archived courses with their status", () => {
    insertCourse("draft-course", base.instructor.id, schema.CourseStatus.Draft);
    const archived = insertCourse(
      "archived-course",
      base.instructor.id,
      schema.CourseStatus.Archived
    );

    const result = getInstructorAnalytics(base.instructor.id);

    expect(
      result.courses.map((c) => ({ id: c.id, status: c.status })).sort((a, b) => a.id - b.id)
    ).toEqual([
      { id: base.course.id, status: schema.CourseStatus.Published },
      { id: archived.id, status: schema.CourseStatus.Archived },
    ]);
  });

  it("counts a student enrolled in two courses once in unique students and once per course", () => {
    const second = insertCourse("second-course", base.instructor.id);
    const otherStudent = insertStudent("other-student@example.com");
    enroll(base.user.id, base.course.id);
    enroll(base.user.id, second.id);
    enroll(otherStudent.id, base.course.id);

    const result = getInstructorAnalytics(base.instructor.id);

    expect(result.totals.uniqueStudents).toBe(2);
    const enrollmentsById = Object.fromEntries(
      result.courses.map((c) => [c.id, c.enrollments])
    );
    expect(enrollmentsById).toEqual({ [base.course.id]: 2, [second.id]: 1 });
  });

  it("sorts courses by enrollments, largest first", () => {
    const popular = insertCourse("popular-course", base.instructor.id);
    const middling = insertCourse("middling-course", base.instructor.id);
    const students = ["a", "b", "c"].map((s) => insertStudent(`${s}@example.com`));
    students.forEach((s) => enroll(s.id, popular.id));
    enroll(students[0].id, middling.id);

    const result = getInstructorAnalytics(base.instructor.id);

    expect(result.courses.map((c) => [c.id, c.enrollments])).toEqual([
      [popular.id, 3],
      [middling.id, 1],
      [base.course.id, 0],
    ]);
  });

  it("returns an empty course list and zero unique students when no courses are in scope", () => {
    const newcomer = insertInstructor("newcomer@example.com");
    const draft = insertCourse("newcomer-draft", newcomer.id, schema.CourseStatus.Draft);
    enroll(base.user.id, draft.id);

    const result = getInstructorAnalytics(newcomer.id);

    expect(result).toEqual({
      totals: { uniqueStudents: 0, completionRate: null, revenue: 0 },
      courses: [],
    });
  });

  describe("completion rate", () => {
    it("is the share of a course's enrollments that are completed, and null with no enrollments", () => {
      const empty = insertCourse("empty-course", base.instructor.id);
      const students = ["a", "b", "c", "d"].map((s) => insertStudent(`${s}@example.com`));
      enroll(students[0].id, base.course.id, COMPLETED_AT);
      enroll(students[1].id, base.course.id);
      enroll(students[2].id, base.course.id);
      enroll(students[3].id, base.course.id);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(courseById(result, base.course.id).completionRate).toBe(25);
      expect(courseById(result, empty.id).completionRate).toBeNull();
    });

    it("overall is all completions over all enrollments across in-scope courses, and null with none", () => {
      const second = insertCourse("second-course", base.instructor.id);
      const draft = insertCourse("draft-course", base.instructor.id, schema.CourseStatus.Draft);
      const other = insertStudent("other@example.com");
      enroll(base.user.id, base.course.id, COMPLETED_AT);
      enroll(other.id, base.course.id);
      enroll(base.user.id, second.id, COMPLETED_AT);
      enroll(other.id, second.id, COMPLETED_AT);
      enroll(other.id, draft.id);

      expect(getInstructorAnalytics(base.instructor.id).totals.completionRate).toBe(75);

      const newcomer = insertInstructor("newcomer@example.com");
      insertCourse("newcomer-course", newcomer.id);
      expect(getInstructorAnalytics(newcomer.id).totals.completionRate).toBeNull();
    });
  });

  describe("average progress", () => {
    it("counts students who haven't started as 0, and is null with no enrollments", () => {
      const lessons = insertLessons(base.course.id, 4);
      const empty = insertCourse("empty-course", base.instructor.id);
      insertLessons(empty.id, 2);
      const notStarted = insertStudent("not-started@example.com");
      enroll(base.user.id, base.course.id);
      enroll(notStarted.id, base.course.id);
      recordProgress(base.user.id, lessons[0].id);
      recordProgress(base.user.id, lessons[1].id);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(courseById(result, base.course.id).averageProgress).toBe(25);
      expect(courseById(result, empty.id).averageProgress).toBeNull();
    });

    it("equals the mean of the Student Roster's progress calculation for a mix of students", () => {
      const lessons = insertLessons(base.course.id, 3);
      const otherCourse = insertCourse("other-course", base.instructor.id);
      const otherLessons = insertLessons(otherCourse.id, 1);
      const noLessons = insertCourse("no-lessons", base.instructor.id);
      const [oneDone, twoDone, inProgress, notStarted] = ["one", "two", "wip", "none"].map(
        (s) => insertStudent(`${s}@example.com`)
      );
      const students = [oneDone, twoDone, inProgress, notStarted];
      students.forEach((s) => enroll(s.id, base.course.id));
      enroll(oneDone.id, noLessons.id);
      recordProgress(oneDone.id, lessons[0].id);
      recordProgress(twoDone.id, lessons[0].id);
      recordProgress(twoDone.id, lessons[1].id);
      recordProgress(inProgress.id, lessons[0].id);
      recordProgress(inProgress.id, lessons[1].id, schema.LessonProgressStatus.InProgress);
      recordProgress(notStarted.id, otherLessons[0].id);

      const result = getInstructorAnalytics(base.instructor.id);

      const rosterProgress = students.map((s) =>
        calculateProgress(s.id, base.course.id, false, false)
      );
      expect(rosterProgress).toEqual([33, 67, 33, 0]);
      expect(courseById(result, base.course.id).averageProgress).toBeCloseTo(
        rosterProgress.reduce((a, b) => a + b, 0) / students.length
      );
      expect(courseById(result, noLessons.id).averageProgress).toBe(
        calculateProgress(oneDone.id, noLessons.id, false, false)
      );
    });
  });

  describe("revenue", () => {
    it("sums the amounts paid per course and in total, across in-scope courses only", () => {
      const second = insertCourse("second-course", base.instructor.id);
      const unsold = insertCourse("unsold-course", base.instructor.id);
      const draft = insertCourse("draft-course", base.instructor.id, schema.CourseStatus.Draft);
      const others = insertCourse("others-course", insertInstructor("other@example.com").id);
      const buyer = insertStudent("buyer@example.com");
      insertPurchase(base.user.id, base.course.id, 4999);
      insertPurchase(buyer.id, base.course.id, 2500); // PPP-discounted price
      insertPurchase(buyer.id, second.id, 1000);
      insertPurchase(buyer.id, draft.id, 7777);
      insertPurchase(buyer.id, others.id, 8888);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(courseById(result, base.course.id).revenue).toBe(7499);
      expect(courseById(result, second.id).revenue).toBe(1000);
      expect(courseById(result, unsold.id).revenue).toBe(0);
      expect(result.totals.revenue).toBe(8499);
    });

    it("counts a team purchase once at its full amount, and coupon redemptions add nothing", () => {
      const lead = insertStudent("lead@example.com");
      const { coupons } = createTeamPurchase(lead.id, base.course.id, 15000, null, 3);
      const redeemers = ["r1", "r2"].map((s) => insertStudent(`${s}@example.com`));
      redeemers.forEach((r, i) => {
        expect(redeemCoupon(coupons[i].code, r.id, "US").ok).toBe(true);
      });

      const result = getInstructorAnalytics(base.instructor.id);

      expect(courseById(result, base.course.id).enrollments).toBe(2);
      expect(courseById(result, base.course.id).revenue).toBe(15000);
      expect(result.totals.revenue).toBe(15000);
    });
  });
});
