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

function insertRating(userId: number, courseId: number, rating: number) {
  testDb.insert(schema.courseRatings).values({ userId, courseId, rating }).run();
}

function insertComment(lessonId: number, userId: number, parentId: number | null = null) {
  return testDb
    .insert(schema.comments)
    .values({ lessonId, userId, parentId, body: "A comment" })
    .returning()
    .get();
}

const PASSING_SCORE = 0.7;

function insertQuiz(courseId: number) {
  const [lesson] = insertLessons(courseId, 1);
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId: lesson.id, title: "Quiz", passingScore: PASSING_SCORE })
    .returning()
    .get();
}

function recordAttempt(userId: number, quizId: number, score: number, attemptedAt: string) {
  return testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId, score, passed: score >= PASSING_SCORE, attemptedAt })
    .returning()
    .get();
}

const isoDay = (n: number) => `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;

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
      totals: { uniqueStudents: 0, completionRate: null, revenue: 0, unansweredQuestions: 0 },
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

  describe("rating", () => {
    it("is the course's rating average and count, with a null average when unrated", () => {
      const unrated = insertCourse("unrated-course", base.instructor.id);
      const [a, b, c] = ["a", "b", "c"].map((s) => insertStudent(`${s}@example.com`));
      insertRating(a.id, base.course.id, 5);
      insertRating(b.id, base.course.id, 4);
      insertRating(c.id, base.course.id, 4);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(courseById(result, base.course.id).rating).toEqual({ average: 4.3, count: 3 });
      expect(courseById(result, unrated.id).rating).toEqual({ average: null, count: 0 });
    });
  });

  describe("unanswered questions", () => {
    it("counts per course, and in total across everything in the Questions queue", () => {
      const admin = insertUser("admin@example.com", schema.UserRole.Admin);
      const second = insertCourse("second-course", base.instructor.id);
      const quiet = insertCourse("quiet-course", base.instructor.id);
      const draft = insertCourse("draft-course", base.instructor.id, schema.CourseStatus.Draft);
      const [draftLesson] = insertLessons(draft.id, 1);
      const others = insertCourse("others-course", insertInstructor("other@example.com").id);
      const [lesson] = insertLessons(base.course.id, 1);
      const [secondLesson] = insertLessons(second.id, 1);
      const [othersLesson] = insertLessons(others.id, 1);
      const peer = insertStudent("peer@example.com");

      insertComment(lesson.id, base.user.id); // unanswered
      const peerAnswered = insertComment(lesson.id, base.user.id);
      insertComment(lesson.id, peer.id, peerAnswered.id); // a student reply doesn't answer it
      const instructorAnswered = insertComment(lesson.id, base.user.id);
      insertComment(lesson.id, base.instructor.id, instructorAnswered.id);
      const adminAnswered = insertComment(lesson.id, base.user.id);
      insertComment(lesson.id, admin.id, adminAnswered.id);
      insertComment(lesson.id, base.instructor.id); // instructor's own post isn't work
      insertComment(secondLesson.id, peer.id); // unanswered
      insertComment(othersLesson.id, peer.id); // another instructor's course
      insertComment(draftLesson.id, peer.id); // in the queue, but drafts get no table row

      const result = getInstructorAnalytics(base.instructor.id);

      expect(courseById(result, base.course.id).unansweredQuestions).toBe(2);
      expect(courseById(result, second.id).unansweredQuestions).toBe(1);
      expect(courseById(result, quiet.id).unansweredQuestions).toBe(0);
      expect(result.courses.map((c) => c.id)).not.toContain(draft.id);
      expect(result.totals.unansweredQuestions).toBe(4);
    });
  });

  describe("quiz scores", () => {
    it("takes a student's best and first attempt: 25%, 25%, 75%, 100% gives 100% best and 25% first", () => {
      const quiz = insertQuiz(base.course.id);
      enroll(base.user.id, base.course.id);
      recordAttempt(base.user.id, quiz.id, 0.75, isoDay(3));
      recordAttempt(base.user.id, quiz.id, 0.25, isoDay(1));
      recordAttempt(base.user.id, quiz.id, 1, isoDay(4));
      recordAttempt(base.user.id, quiz.id, 0.25, isoDay(2));

      const course = courseById(getInstructorAnalytics(base.instructor.id), base.course.id);

      expect(course.averageBestQuizScore).toBe(100);
      expect(course.averageFirstQuizScore).toBe(25);
    });

    it("resolves attempts with the same timestamp to the lowest id as first", () => {
      const quiz = insertQuiz(base.course.id);
      enroll(base.user.id, base.course.id);
      recordAttempt(base.user.id, quiz.id, 0.5, isoDay(1));
      recordAttempt(base.user.id, quiz.id, 0.9, isoDay(1));

      const course = courseById(getInstructorAnalytics(base.instructor.id), base.course.id);

      expect(course.averageFirstQuizScore).toBe(50);
      expect(course.averageBestQuizScore).toBe(90);
    });

    it("counts each student once per quiz in both averages, however many retakes", () => {
      const quizA = insertQuiz(base.course.id);
      const quizB = insertQuiz(base.course.id);
      const retaker = insertStudent("retaker@example.com");
      enroll(retaker.id, base.course.id);
      enroll(base.user.id, base.course.id);
      // retaker on quiz A: first 0.2, best 1.0 (five attempts)
      recordAttempt(retaker.id, quizA.id, 0.2, isoDay(1));
      [0.4, 0.6, 0.8, 1].forEach((score, i) => recordAttempt(retaker.id, quizA.id, score, isoDay(i + 2)));
      // base user on quiz A: single 0.6
      recordAttempt(base.user.id, quizA.id, 0.6, isoDay(1));
      // base user on quiz B: first 0.4, best 0.7
      recordAttempt(base.user.id, quizB.id, 0.4, isoDay(1));
      recordAttempt(base.user.id, quizB.id, 0.7, isoDay(2));

      const course = courseById(getInstructorAnalytics(base.instructor.id), base.course.id);

      expect(course.averageBestQuizScore).toBeCloseTo((100 + 60 + 70) / 3);
      expect(course.averageFirstQuizScore).toBeCloseTo((20 + 60 + 40) / 3);
    });

    it("are both null for a course with no quiz attempts", () => {
      insertQuiz(base.course.id);
      const other = insertCourse("other-course", base.instructor.id);
      enroll(base.user.id, other.id);
      recordAttempt(base.user.id, insertQuiz(other.id).id, 0.5, isoDay(1));

      const result = getInstructorAnalytics(base.instructor.id);

      expect(courseById(result, base.course.id).averageBestQuizScore).toBeNull();
      expect(courseById(result, base.course.id).averageFirstQuizScore).toBeNull();
      expect(courseById(result, other.id).averageBestQuizScore).toBe(50);
    });

    it("counts only enrolled students, like the Student Roster", () => {
      const quiz = insertQuiz(base.course.id);
      const outsider = insertStudent("outsider@example.com");
      enroll(base.user.id, base.course.id);
      recordAttempt(base.user.id, quiz.id, 0.8, isoDay(1));
      recordAttempt(outsider.id, quiz.id, 0.2, isoDay(1));
      recordAttempt(base.instructor.id, quiz.id, 0.4, isoDay(1));

      const course = courseById(getInstructorAnalytics(base.instructor.id), base.course.id);

      expect(course.averageBestQuizScore).toBe(80);
      expect(course.averageFirstQuizScore).toBe(80);
    });
  });
});
