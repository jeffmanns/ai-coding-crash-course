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
import { rateCourse } from "./courseRatingService";
import { createComment } from "./commentService";

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
    const other = insertInstructor("other@example.com");
    insertCourse("Other Course", other.id);

    const result = getInstructorAnalytics(base.instructor.id);

    expect(result.courses.map((c) => c.title)).toEqual(["Test Course"]);
  });

  it("excludes drafts and includes published and archived courses with their status", () => {
    insertCourse("Archived Course", base.instructor.id, schema.CourseStatus.Archived);
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
    expect(enrollmentsByTitle).toEqual({ "Test Course": 2, "Second Course": 1 });
  });

  it("sorts courses by enrollments, largest first", () => {
    const big = insertCourse("Big Course", base.instructor.id);
    const medium = insertCourse("Medium Course", base.instructor.id);
    const students = ["a", "b", "c"].map((s) => insertStudent(`${s}@example.com`));
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
    const other = insertStudent("rater@example.com");
    rateCourse(base.user.id, base.course.id, 5);
    rateCourse(other.id, base.course.id, 4);

    const result = getInstructorAnalytics(base.instructor.id);

    const byId = Object.fromEntries(result.courses.map((c) => [c.id, c.rating]));
    expect(byId[base.course.id]).toEqual({ average: 4.5, count: 2 });
    expect(byId[unrated.id]).toEqual({ average: null, count: 0 });
  });

  it("counts unanswered questions per course and in total, matching the Questions queue", () => {
    const second = insertCourse("Second Course", base.instructor.id);
    const draft = insertCourse("Draft Course", base.instructor.id, schema.CourseStatus.Draft);
    const otherInstructor = insertInstructor("other@example.com");
    const othersCourse = insertCourse("Other Course", otherInstructor.id);
    const admin = testDb
      .insert(schema.users)
      .values({ name: "Admin", email: "admin@example.com", role: schema.UserRole.Admin })
      .returning()
      .get();
    const peer = insertStudent("peer@example.com");
    const lesson = insertLesson(base.course.id);
    const secondLesson = insertLesson(second.id);

    // Test Course: 2 unanswered
    createComment(base.user.id, lesson.id, null, "No reply yet");
    const peerAnswered = createComment(base.user.id, lesson.id, null, "Only a peer replied");
    createComment(peer.id, lesson.id, peerAnswered.id, "Me neither");
    // Answered by staff, or asked by the instructor: not counted
    const byInstructor = createComment(base.user.id, lesson.id, null, "Instructor answered");
    createComment(base.instructor.id, lesson.id, byInstructor.id, "Answer");
    const byAdmin = createComment(base.user.id, lesson.id, null, "Admin answered");
    createComment(admin.id, lesson.id, byAdmin.id, "Answer");
    createComment(base.instructor.id, lesson.id, null, "Instructor's own note");
    // Second Course: 1 unanswered
    createComment(peer.id, secondLesson.id, null, "Second course question");
    // Out of scope: draft course and another instructor's course
    createComment(peer.id, insertLesson(draft.id).id, null, "Draft question");
    createComment(peer.id, insertLesson(othersCourse.id).id, null, "Other question");

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
    const other = insertStudent("other-student@example.com");
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
    const newcomer = insertInstructor("newcomer@example.com");
    const draft = insertCourse("Draft Only", newcomer.id, schema.CourseStatus.Draft);
    enroll(base.user.id, draft.id);

    const result = getInstructorAnalytics(newcomer.id);

    expect(result).toEqual({
      totals: { uniqueStudents: 0, unansweredQuestions: 0 },
      courses: [],
    });
  });
});
