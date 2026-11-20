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
import { rateCourse } from "./courseRatingService";
import { createComment } from "./commentService";
import { calculateProgress } from "./progressService";
import { createPurchase, createTeamPurchase } from "./purchaseService";
import { redeemCoupon } from "./couponService";
import { unenrollUser } from "./enrollmentService";

function insertUser(email: string, role: schema.UserRole) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role })
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

function insertLesson(courseId: number, title = "Lesson") {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: `${title} module`, position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title, position: 1 })
    .returning()
    .get();
}

function insertQuiz(courseId: number, title = "Quiz") {
  const lesson = insertLesson(courseId, `${title} lesson`);
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId: lesson.id, title, passingScore: 0.7 })
    .returning()
    .get();
}

function attempt(
  userId: number,
  quizId: number,
  score: number,
  attemptedAt: string
) {
  testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId, score, passed: score >= 0.7, attemptedAt })
    .run();
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
    const other = insertUser("other@example.com", schema.UserRole.Instructor);
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
    const other = insertUser(
      "other-student@example.com",
      schema.UserRole.Student
    );
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
      insertUser(`${s}@example.com`, schema.UserRole.Student)
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

  // ─── Ratings, unanswered questions, quiz averages (#6) ───

  it("reports each course's rating average and count, with a null average when unrated", () => {
    const unrated = insertCourse("Unrated Course", base.instructor.id);
    const other = insertUser("rater@example.com", schema.UserRole.Student);
    rateCourse(base.user.id, base.course.id, 5);
    rateCourse(other.id, base.course.id, 4);

    const result = getInstructorAnalytics(base.instructor.id);

    const byId = Object.fromEntries(
      result.courses.map((c) => [c.id, c.rating])
    );
    expect(byId[base.course.id]).toEqual({ average: 4.5, count: 2 });
    expect(byId[unrated.id]).toEqual({ average: null, count: 0 });
  });

  it("counts unanswered questions per course and in total, matching the Questions queue", () => {
    const second = insertCourse("Second Course", base.instructor.id);
    const draft = insertCourse(
      "Draft Course",
      base.instructor.id,
      schema.CourseStatus.Draft
    );
    const otherInstructor = insertUser(
      "other@example.com",
      schema.UserRole.Instructor
    );
    const othersCourse = insertCourse("Other Course", otherInstructor.id);
    const admin = insertUser("admin@example.com", schema.UserRole.Admin);
    const peer = insertUser("peer@example.com", schema.UserRole.Student);
    const lesson = insertLesson(base.course.id);
    const secondLesson = insertLesson(second.id);

    // Test Course: 2 unanswered
    createComment(base.user.id, lesson.id, null, "No reply yet");
    const peerAnswered = createComment(
      base.user.id,
      lesson.id,
      null,
      "Only a peer replied"
    );
    createComment(peer.id, lesson.id, peerAnswered.id, "Me neither");
    // Answered by staff, or asked by the instructor: not counted
    const byInstructor = createComment(
      base.user.id,
      lesson.id,
      null,
      "Instructor answered"
    );
    createComment(base.instructor.id, lesson.id, byInstructor.id, "Answer");
    const byAdmin = createComment(
      base.user.id,
      lesson.id,
      null,
      "Admin answered"
    );
    createComment(admin.id, lesson.id, byAdmin.id, "Answer");
    createComment(base.instructor.id, lesson.id, null, "Instructor's own note");
    // Second Course: 1 unanswered
    createComment(peer.id, secondLesson.id, null, "Second course question");
    // Out of scope: draft course and another instructor's course
    createComment(peer.id, insertLesson(draft.id).id, null, "Draft question");
    createComment(
      peer.id,
      insertLesson(othersCourse.id).id,
      null,
      "Other question"
    );

    const result = getInstructorAnalytics(base.instructor.id);

    const byTitle = Object.fromEntries(
      result.courses.map((c) => [c.title, c.unansweredQuestions])
    );
    expect(byTitle).toEqual({ "Test Course": 2, "Second Course": 1 });
    expect(result.totals.unansweredQuestions).toBe(3);
  });

  it("averages the best attempt and the first attempt separately for a student who retakes", () => {
    const quiz = insertQuiz(base.course.id);
    enroll(base.user.id, base.course.id);
    // Inserted out of order: "first" is by attempt time, not insertion order.
    attempt(base.user.id, quiz.id, 0.75, "2026-01-03T00:00:00.000Z");
    attempt(base.user.id, quiz.id, 0.25, "2026-01-01T00:00:00.000Z");
    attempt(base.user.id, quiz.id, 1, "2026-01-04T00:00:00.000Z");
    attempt(base.user.id, quiz.id, 0.25, "2026-01-02T00:00:00.000Z");

    const [course] = getInstructorAnalytics(base.instructor.id).courses;

    expect(course.avgBestQuizScore).toBe(1);
    expect(course.avgFirstQuizScore).toBe(0.25);
  });

  it("resolves the first attempt to the lowest id when attempt times tie", () => {
    const quiz = insertQuiz(base.course.id);
    enroll(base.user.id, base.course.id);
    attempt(base.user.id, quiz.id, 0.9, "2026-01-01T00:00:00.000Z");
    attempt(base.user.id, quiz.id, 0.4, "2026-01-01T00:00:00.000Z");

    const [course] = getInstructorAnalytics(base.instructor.id).courses;

    expect(course.avgFirstQuizScore).toBe(0.9);
  });

  it("counts each student once per quiz in both quiz averages, however many retakes", () => {
    const quizA = insertQuiz(base.course.id, "Quiz A");
    const quizB = insertQuiz(base.course.id, "Quiz B");
    const other = insertUser(
      "other-student@example.com",
      schema.UserRole.Student
    );
    enroll(base.user.id, base.course.id);
    enroll(other.id, base.course.id);
    attempt(base.user.id, quizA.id, 0.2, "2026-01-01T00:00:00.000Z");
    attempt(base.user.id, quizA.id, 0.4, "2026-01-02T00:00:00.000Z");
    attempt(base.user.id, quizA.id, 0.6, "2026-01-03T00:00:00.000Z");
    attempt(base.user.id, quizB.id, 0.5, "2026-01-04T00:00:00.000Z");
    attempt(other.id, quizA.id, 1, "2026-01-01T00:00:00.000Z");

    const [course] = getInstructorAnalytics(base.instructor.id).courses;

    // Pairs: (user, A) best 0.6 first 0.2; (user, B) 0.5; (other, A) 1.0
    expect(course.avgBestQuizScore).toBeCloseTo(0.7);
    expect(course.avgFirstQuizScore).toBeCloseTo(1.7 / 3);
  });

  it("leaves students who have unenrolled out of both quiz averages, matching the Student Roster", () => {
    const quiz = insertQuiz(base.course.id);
    const leaver = insertUser("leaver@example.com", schema.UserRole.Student);
    enroll(base.user.id, base.course.id);
    enroll(leaver.id, base.course.id);
    attempt(base.user.id, quiz.id, 0.5, "2026-01-01T00:00:00.000Z");
    attempt(leaver.id, quiz.id, 1, "2026-01-01T00:00:00.000Z");
    unenrollUser(leaver.id, base.course.id);

    const [course] = getInstructorAnalytics(base.instructor.id).courses;

    expect(course.avgBestQuizScore).toBe(0.5);
    expect(course.avgFirstQuizScore).toBe(0.5);
  });

  it("reports null quiz averages for a course with no quiz attempts", () => {
    insertQuiz(base.course.id);
    const noQuiz = insertCourse("No Quiz Course", base.instructor.id);
    enroll(base.user.id, base.course.id);

    const result = getInstructorAnalytics(base.instructor.id);

    for (const id of [base.course.id, noQuiz.id]) {
      const course = result.courses.find((c) => c.id === id)!;
      expect(course.avgBestQuizScore).toBeNull();
      expect(course.avgFirstQuizScore).toBeNull();
    }
  });

  it("returns an empty course list and zero unique students when no courses are in scope", () => {
    const newcomer = insertUser(
      "newcomer@example.com",
      schema.UserRole.Instructor
    );
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
        revenue: 0,
        completionRate: null,
        unansweredQuestions: 0,
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
      insertUser(`${s}@example.com`, schema.UserRole.Student)
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
    const [a, b] = ["a", "b"].map((s) =>
      insertUser(`${s}@example.com`, schema.UserRole.Student)
    );
    enroll(a.id, base.course.id);
    enroll(b.id, base.course.id);
    setLessonStatus(a.id, lessons[0].id);
    setLessonStatus(a.id, lessons[1].id);

    const courses = coursesByTitle(getInstructorAnalytics(base.instructor.id));

    expect(courses["Test Course"].avgProgress).toBe(0.25);
    expect(courses["Empty Course"].avgProgress).toBeNull();
  });

  it("matches the mean of the Student Roster's progress calculation for a mix of students", () => {
    const lessons = addLessons(base.course.id, 7);
    const noLessons = insertCourse("No Lessons", base.instructor.id);
    const students = ["a", "b", "c", "d", "e"].map((s) =>
      insertUser(`${s}@example.com`, schema.UserRole.Student)
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
    expect(courses["Test Course"].avgProgress).toBeCloseTo(2.28 / 5);
    expect(courses["No Lessons"].avgProgress).toBe(
      calculateProgress(students[0].id, noLessons.id, false, false) / 100
    );
    expect(courses["No Lessons"].avgProgress).toBe(0);
  });

  it("sums revenue paid per course and in total", () => {
    const second = insertCourse("Second Course", base.instructor.id);
    insertCourse("Unsold Course", base.instructor.id);
    const [a, b] = ["a", "b"].map((s) =>
      insertUser(`${s}@example.com`, schema.UserRole.Student)
    );
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
    const buyer = insertUser("buyer@example.com", schema.UserRole.Student);
    const { coupons } = createTeamPurchase(
      buyer.id,
      base.course.id,
      5999 * 3,
      "US",
      3
    );
    const seats = ["a", "b", "c"].map((s) =>
      insertUser(`${s}@example.com`, schema.UserRole.Student)
    );
    seats.forEach((s, i) => {
      expect(redeemCoupon(coupons[i].code, s.id, "US").ok).toBe(true);
    });

    const result = getInstructorAnalytics(base.instructor.id);

    expect(coursesByTitle(result)["Test Course"].enrollments).toBe(3);
    expect(coursesByTitle(result)["Test Course"].revenue).toBe(17997);
    expect(result.totals.revenue).toBe(17997);
  });
});
