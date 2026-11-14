import { and, countDistinct, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import { courses, CourseStatus, enrollments } from "~/db/schema";

// ─── Instructor Analytics Service ───
// Aggregate metrics across an instructor's courses for the Analytics page.
// getInstructorAnalytics is the single public entry point; later metrics are
// added to its result. Metrics with no data are null (rendered as "—").
// Uses positional parameters (project convention).

const IN_SCOPE_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

function inScopeCourses(instructorId: number) {
  return and(
    eq(courses.instructorId, instructorId),
    inArray(courses.status, IN_SCOPE_STATUSES)
  );
}

export function getInstructorAnalytics(instructorId: number) {
  const enrollmentCount = sql<number>`count(${enrollments.id})`;

  const courseRows = db
    .select({
      id: courses.id,
      title: courses.title,
      status: courses.status,
      enrollments: enrollmentCount,
    })
    .from(courses)
    .leftJoin(enrollments, eq(enrollments.courseId, courses.id))
    .where(inScopeCourses(instructorId))
    .groupBy(courses.id)
    .orderBy(desc(enrollmentCount), courses.id)
    .all();

  const studentRow = db
    .select({ uniqueStudents: countDistinct(enrollments.userId) })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(inScopeCourses(instructorId))
    .get();

  return {
    totals: { uniqueStudents: studentRow?.uniqueStudents ?? 0 },
    courses: courseRows,
  };
}
