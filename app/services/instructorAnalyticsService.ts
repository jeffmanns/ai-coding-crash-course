import { and, countDistinct, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  CourseStatus,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
} from "~/db/schema";

// ─── Instructor Analytics Service ───
// Aggregate metrics across an instructor's courses for the Analytics page.
// getInstructorAnalytics is the single public entry point; later metrics are
// added to its result. Metrics with no data are null (rendered as "—").
// Rates (completionRate, averageProgress) are percentages 0–100, unrounded;
// revenue is in cents.
// Uses positional parameters (project convention).

const IN_SCOPE_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

function inScopeCourses(instructorId: number) {
  return and(
    eq(courses.instructorId, instructorId),
    inArray(courses.status, IN_SCOPE_STATUSES)
  );
}

// Lessons per course, for the unweighted, lessons-only progress calculation.
function lessonCountsByCourse() {
  return db
    .select({
      courseId: modules.courseId,
      lessonCount: sql<number>`count(${lessons.id})`.as("lesson_count"),
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .groupBy(modules.courseId)
    .as("lesson_counts");
}

// Completed lessons per (student, course).
function completedLessonsByStudent() {
  return db
    .select({
      userId: lessonProgress.userId,
      courseId: modules.courseId,
      completedCount: sql<number>`count(*)`.as("completed_count"),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessonProgress.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(lessonProgress.status, LessonProgressStatus.Completed))
    .groupBy(lessonProgress.userId, modules.courseId)
    .as("completed_lessons");
}

// Amount paid per course, in cents. A team purchase is a single row at its full
// amount; coupon redemptions create no purchase row and so add nothing.
function revenueByCourse() {
  return db
    .select({
      courseId: purchases.courseId,
      total: sql<number>`sum(${purchases.amountPaid})`.as("revenue_total"),
    })
    .from(purchases)
    .groupBy(purchases.courseId)
    .as("course_revenue");
}

export function getInstructorAnalytics(instructorId: number) {
  const enrollmentCount = sql<number>`count(${enrollments.id})`;
  const completionRate = sql<number | null>`100.0 * count(${enrollments.completedAt}) / nullif(count(${enrollments.id}), 0)`;

  const lessonCounts = lessonCountsByCourse();
  const completedLessons = completedLessonsByStudent();
  const courseRevenue = revenueByCourse();

  // Mirrors calculateProgress(userId, courseId, false, false) per enrollment:
  // round(completed / lessons * 100), or 0 for a course with no lessons.
  // Students who haven't started have no completed rows and count as 0.
  const averageProgress = sql<number | null>`avg(
    case
      when ${enrollments.id} is null then null
      when coalesce(${lessonCounts.lessonCount}, 0) = 0 then 0
      else round(100.0 * coalesce(${completedLessons.completedCount}, 0) / ${lessonCounts.lessonCount})
    end
  )`;

  const courseRows = db
    .select({
      id: courses.id,
      title: courses.title,
      status: courses.status,
      enrollments: enrollmentCount,
      completionRate,
      averageProgress,
      // One revenue row per course, repeated on each enrollment row; max() picks it.
      revenue: sql<number>`coalesce(max(${courseRevenue.total}), 0)`,
    })
    .from(courses)
    .leftJoin(enrollments, eq(enrollments.courseId, courses.id))
    .leftJoin(lessonCounts, eq(lessonCounts.courseId, courses.id))
    .leftJoin(courseRevenue, eq(courseRevenue.courseId, courses.id))
    .leftJoin(
      completedLessons,
      and(
        eq(completedLessons.userId, enrollments.userId),
        eq(completedLessons.courseId, enrollments.courseId)
      )
    )
    .where(inScopeCourses(instructorId))
    .groupBy(courses.id)
    .orderBy(desc(enrollmentCount), courses.id)
    .all();

  const studentRow = db
    .select({
      uniqueStudents: countDistinct(enrollments.userId),
      completionRate,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(inScopeCourses(instructorId))
    .get();

  return {
    totals: {
      uniqueStudents: studentRow?.uniqueStudents ?? 0,
      completionRate: studentRow?.completionRate ?? null,
      revenue: courseRows.reduce((sum, course) => sum + course.revenue, 0),
    },
    courses: courseRows,
  };
}
