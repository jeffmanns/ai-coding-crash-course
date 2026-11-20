import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
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
import { createPurchase, createTeamPurchase } from "./purchaseService";
import { redeemCoupon } from "./couponService";

function insertInstructor(email: string) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role: schema.UserRole.Instructor })
    .returning()
    .get();
}

function insertStudent(email: string) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role: schema.UserRole.Student })
    .returning()
    .get();
}

function insertCourse(
  title: string,
  instructorId: number,
  status: schema.CourseStatus = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title,
      slug: title.toLowerCase().replace(/\s+/g, "-"),
      description: title,
      salesCopy: title,
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function enroll(userId: number, courseId: number) {
  testDb.insert(schema.enrollments).values({ userId, courseId }).run();
}

describe("getInstructorAnalytics", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("returns only the given instructor's courses", () => {
    const other = insertInstructor("other@example.com");
    insertCourse("Other Course", other.id);

    const result = getInstructorAnalytics(base.instructor.id);

    expect(result.courses.map((c) => c.title)).toEqual(["Test Course"]);
  });

  it("excludes drafts and includes published and archived courses with their status", () => {
    insertCourse(
      "Archived Course",
      base.instructor.id,
      schema.CourseStatus.Archived
    );
    insertCourse("Draft Course", base.instructor.id, schema.CourseStatus.Draft);

    const result = getInstructorAnalytics(base.instructor.id);

    expect(
      result.courses.map((c) => ({ title: c.title, status: c.status }))
    ).toEqual(
      expect.arrayContaining([
        { title: "Test Course", status: "published" },
        { title: "Archived Course", status: "archived" },
      ])
    );
    expect(result.courses).toHaveLength(2);
  });

  it("counts a student in two courses once in unique students and once per course", () => {
    const second = insertCourse("Second Course", base.instructor.id);
    const other = insertStudent("other-student@example.com");
    enroll(base.user.id, base.course.id);
    enroll(base.user.id, second.id);
    enroll(other.id, base.course.id);

    const result = getInstructorAnalytics(base.instructor.id);

    expect(result.totals.uniqueStudents).toBe(2);
    const enrollmentsByTitle = Object.fromEntries(
      result.courses.map((c) => [c.title, c.enrollments])
    );
    expect(enrollmentsByTitle).toEqual({
      "Test Course": 2,
      "Second Course": 1,
    });
  });

  it("sorts courses by enrollments, largest first", () => {
    const big = insertCourse("Big Course", base.instructor.id);
    const medium = insertCourse("Medium Course", base.instructor.id);
    const students = ["a", "b", "c"].map((s) =>
      insertStudent(`${s}@example.com`)
    );
    students.forEach((s) => enroll(s.id, big.id));
    enroll(students[0].id, medium.id);
    enroll(students[1].id, medium.id);

    const result = getInstructorAnalytics(base.instructor.id);

    expect(result.courses.map((c) => [c.title, c.enrollments])).toEqual([
      ["Big Course", 3],
      ["Medium Course", 2],
      ["Test Course", 0],
    ]);
  });

  it("returns an empty course list and zero unique students when no courses are in scope", () => {
    const newcomer = insertInstructor("newcomer@example.com");
    const draft = insertCourse(
      "Draft Only",
      newcomer.id,
      schema.CourseStatus.Draft
    );
    enroll(base.user.id, draft.id);

    const result = getInstructorAnalytics(newcomer.id);

    expect(result).toEqual({
      totals: {
        uniqueStudents: 0,
        completionRate: null,
        revenue: 0,
      },
      courses: [],
    });
  });
});

describe("getInstructorAnalytics — completion, progress and revenue", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  function complete(userId: number, courseId: number) {
    testDb
      .update(schema.enrollments)
      .set({ completedAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.enrollments.userId, userId),
          eq(schema.enrollments.courseId, courseId)
        )
      )
      .run();
  }

  function coursesByTitle(result: ReturnType<typeof getInstructorAnalytics>) {
    return Object.fromEntries(result.courses.map((c) => [c.title, c]));
  }

  it("reports completion rate per course and overall, null for a course with no enrollments", () => {
    const second = insertCourse("Second Course", base.instructor.id);
    insertCourse("Empty Course", base.instructor.id);
    const [a, b, c] = ["a", "b", "c"].map((s) =>
      insertStudent(`${s}@example.com`)
    );
    enroll(a.id, base.course.id);
    enroll(b.id, base.course.id);
    enroll(c.id, base.course.id);
    enroll(a.id, second.id);
    complete(a.id, base.course.id);
    complete(a.id, second.id);

    const result = getInstructorAnalytics(base.instructor.id);
    const courses = coursesByTitle(result);

    expect(courses["Test Course"].completionRate).toBeCloseTo(1 / 3);
    expect(courses["Second Course"].completionRate).toBe(1);
    expect(courses["Empty Course"].completionRate).toBeNull();
    expect(result.totals.completionRate).toBe(0.5);
  });

  function addLessons(courseId: number, count: number) {
    const mod = testDb
      .insert(schema.modules)
      .values({ courseId, title: "Module", position: 1 })
      .returning()
      .get();
    return Array.from({ length: count }, (_, i) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${i + 1}`, position: i + 1 })
        .returning()
        .get()
    );
  }

  function setLessonStatus(
    userId: number,
    lessonId: number,
    status: schema.LessonProgressStatus = schema.LessonProgressStatus.Completed
  ) {
    testDb
      .insert(schema.lessonProgress)
      .values({ userId, lessonId, status })
      .run();
  }

  it("averages progress over every enrolled student, counting not-started students as 0", () => {
    insertCourse("Empty Course", base.instructor.id);
    const lessons = addLessons(base.course.id, 4);
    const [a, b] = ["a", "b"].map((s) => insertStudent(`${s}@example.com`));
    enroll(a.id, base.course.id);
    enroll(b.id, base.course.id);
    setLessonStatus(a.id, lessons[0].id);
    setLessonStatus(a.id, lessons[1].id);

    const courses = coursesByTitle(getInstructorAnalytics(base.instructor.id));

    expect(courses["Test Course"].avgProgress).toBe(25);
    expect(courses["Empty Course"].avgProgress).toBeNull();
  });

  it("matches the mean of the Student Roster's progress calculation for a mix of students", () => {
    const lessons = addLessons(base.course.id, 7);
    const noLessons = insertCourse("No Lessons", base.instructor.id);
    const students = ["a", "b", "c", "d", "e"].map((s) =>
      insertStudent(`${s}@example.com`)
    );
    students.forEach((s) => enroll(s.id, base.course.id));
    enroll(students[0].id, noLessons.id);
    const completedCounts = [1, 3, 5, 0, 7];
    students.forEach((s, i) =>
      lessons
        .slice(0, completedCounts[i])
        .forEach((l) => setLessonStatus(s.id, l.id))
    );
    // Only completed lessons count towards progress.
    setLessonStatus(
      students[3].id,
      lessons[0].id,
      schema.LessonProgressStatus.InProgress
    );
    setLessonStatus(
      students[0].id,
      lessons[6].id,
      schema.LessonProgressStatus.NotStarted
    );

    const courses = coursesByTitle(getInstructorAnalytics(base.instructor.id));

    const rosterProgress = students.map((s) =>
      calculateProgress(s.id, base.course.id, false, false)
    );
    expect(rosterProgress).toEqual([14, 43, 71, 0, 100]);
    expect(courses["Test Course"].avgProgress).toBeCloseTo(228 / 5);
    expect(courses["No Lessons"].avgProgress).toBe(
      calculateProgress(students[0].id, noLessons.id, false, false)
    );
    expect(courses["No Lessons"].avgProgress).toBe(0);
  });

  it("sums revenue paid per course and in total", () => {
    const second = insertCourse("Second Course", base.instructor.id);
    insertCourse("Unsold Course", base.instructor.id);
    const [a, b] = ["a", "b"].map((s) => insertStudent(`${s}@example.com`));
    createPurchase(a.id, base.course.id, 4999, "US");
    createPurchase(b.id, base.course.id, 2499, "IN"); // PPP-discounted
    createPurchase(a.id, second.id, 1000, "US");

    const result = getInstructorAnalytics(base.instructor.id);
    const courses = coursesByTitle(result);

    expect(courses["Test Course"].revenue).toBe(7498);
    expect(courses["Second Course"].revenue).toBe(1000);
    expect(courses["Unsold Course"].revenue).toBe(0);
    expect(result.totals.revenue).toBe(8498);
  });

  it("counts a team purchase once at its full amount and adds nothing for coupon redemptions", () => {
    const buyer = insertStudent("buyer@example.com");
    const { coupons } = createTeamPurchase(
      buyer.id,
      base.course.id,
      5999 * 3,
      "US",
      3
    );
    const seats = ["a", "b", "c"].map((s) => insertStudent(`${s}@example.com`));
    seats.forEach((s, i) => {
      expect(redeemCoupon(coupons[i].code, s.id, "US").ok).toBe(true);
    });

    const result = getInstructorAnalytics(base.instructor.id);

    expect(coursesByTitle(result)["Test Course"].enrollments).toBe(3);
    expect(coursesByTitle(result)["Test Course"].revenue).toBe(17997);
    expect(result.totals.revenue).toBe(17997);
  });
});
