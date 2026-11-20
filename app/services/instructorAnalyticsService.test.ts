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

  it("returns an empty course list and zero unique students when no courses are in scope", () => {
    const newcomer = insertInstructor("newcomer@example.com");
    const draft = insertCourse("Draft Only", newcomer.id, schema.CourseStatus.Draft);
    enroll(base.user.id, draft.id);

    const result = getInstructorAnalytics(newcomer.id);

    expect(result).toEqual({ totals: { uniqueStudents: 0 }, courses: [] });
  });
});
