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

    expect(result).toEqual({ totals: { uniqueStudents: 0 }, courses: [] });
  });
});
