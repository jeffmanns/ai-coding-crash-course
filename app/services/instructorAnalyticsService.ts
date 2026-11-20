import { and, countDistinct, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import { courses, CourseStatus, enrollments } from "~/db/schema";

// ─── Instructor Analytics Service ───
// Snapshot metrics across an instructor's published and archived courses.
// One public function, getInstructorAnalytics; later metrics are added to its
// result. Metrics with no data are `null` (rendered as "—").

const IN_SCOPE_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

export type InstructorAnalyticsTotals = {
  uniqueStudents: number;
};

export type InstructorCourseAnalytics = {
  id: number;
  title: string;
  status: CourseStatus;
  enrollments: number;
};

export type InstructorAnalytics = {
  totals: InstructorAnalyticsTotals;
  courses: InstructorCourseAnalytics[]; // sorted by enrollments, descending
};

function inScope(instructorId: number) {
  return and(
    eq(courses.instructorId, instructorId),
    inArray(courses.status, IN_SCOPE_STATUSES)
  );
}

export function getInstructorAnalytics(
  instructorId: number
): InstructorAnalytics {
  const courseRows = db
    .select({
      id: courses.id,
      title: courses.title,
      status: courses.status,
      enrollments: sql<number>`count(${enrollments.id})`,
    })
    .from(courses)
    .leftJoin(enrollments, eq(enrollments.courseId, courses.id))
    .where(inScope(instructorId))
    .groupBy(courses.id)
    .orderBy(desc(sql`count(${enrollments.id})`), courses.id)
    .all();

  const totalsRow = db
    .select({ uniqueStudents: countDistinct(enrollments.userId) })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(inScope(instructorId))
    .get();

  return {
    totals: { uniqueStudents: totalsRow?.uniqueStudents ?? 0 },
    courses: courseRows,
  };
}
