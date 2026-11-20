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
  quizAttempts,
  quizzes,
} from "~/db/schema";
import {
  getCourseRatingSummaries,
  type CourseRatingSummary,
} from "~/services/courseRatingService";
import { getUnansweredQuestions } from "~/services/commentService";

// ─── Instructor Analytics Service ───
// Snapshot metrics across an instructor's published and archived courses.
// One public function, getInstructorAnalytics; later metrics are added to its
// result. Metrics with no data are `null` (rendered as "—").

const IN_SCOPE_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

export type InstructorAnalyticsTotals = {
  uniqueStudents: number;
  revenue: number; // cents
  completionRate: number | null; // 0–1
  unansweredQuestions: number;
};

export type InstructorCourseAnalytics = {
  id: number;
  title: string;
  status: CourseStatus;
  enrollments: number;
  completionRate: number | null; // 0–1
  avgProgress: number | null; // 0–100
  revenue: number; // cents
  rating: CourseRatingSummary;
  unansweredQuestions: number;
  avgBestQuizScore: number | null; // 0–1 fraction
  avgFirstQuizScore: number | null; // 0–1 fraction
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

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Reuses the Questions queue's definition of "unanswered" so the counts match
 * when the instructor clicks through. Out-of-scope (draft) courses are dropped
 * by the caller, which only looks up in-scope course ids.
 */
function countUnansweredByCourse(instructorId: number) {
  const counts = new Map<number, number>();
  for (const question of getUnansweredQuestions(instructorId)) {
    counts.set(question.courseId, (counts.get(question.courseId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Per course, the average over every (student, quiz) pair of that pair's best
 * score and of its first score (earliest attempt, lowest id breaks ties). Each
 * pair counts once, however many retakes it has. Courses with no attempts are
 * absent from the map.
 */
function getQuizScoreAverages(courseIds: number[]) {
  const averages = new Map<number, { avgBest: number; avgFirst: number }>();
  if (courseIds.length === 0) return averages;

  const pair = sql`partition by ${quizAttempts.userId}, ${quizAttempts.quizId}`;
  const ranked = db
    .select({
      courseId: modules.courseId,
      score: quizAttempts.score,
      bestScore: sql<number>`max(${quizAttempts.score}) over (${pair})`.as(
        "best_score"
      ),
      attemptOrder:
        sql<number>`row_number() over (${pair} order by ${quizAttempts.attemptedAt}, ${quizAttempts.id})`.as(
          "attempt_order"
        ),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(inArray(modules.courseId, courseIds))
    .as("ranked");

  // One row per (student, quiz) pair: its first attempt, carrying its best.
  const rows = db
    .select({
      courseId: ranked.courseId,
      avgBest: sql<number>`avg(${ranked.bestScore})`,
      avgFirst: sql<number>`avg(${ranked.score})`,
    })
    .from(ranked)
    .where(eq(ranked.attemptOrder, 1))
    .groupBy(ranked.courseId)
    .all();

  for (const row of rows) {
    averages.set(row.courseId, {
      avgBest: row.avgBest,
      avgFirst: row.avgFirst,
    });
  }
  return averages;
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

  const progress = getProgressByCourse(instructorId);
  const revenue = getRevenueByCourse(instructorId);
  const courseIds = courseRows.map((row) => row.id);
  const ratings = getCourseRatingSummaries(courseIds);
  const unanswered = countUnansweredByCourse(instructorId);
  const quizScores = getQuizScoreAverages(courseIds);

  const courseResults = courseRows.map((row) => ({
    ...row,
    ...getCourseProgressMetrics(row, progress),
    revenue: revenue.get(row.id) ?? 0,
    rating: ratings.get(row.id)!,
    unansweredQuestions: unanswered.get(row.id) ?? 0,
    avgBestQuizScore: quizScores.get(row.id)?.avgBest ?? null,
    avgFirstQuizScore: quizScores.get(row.id)?.avgFirst ?? null,
  }));

  return {
    totals: {
      uniqueStudents: totalsRow?.uniqueStudents ?? 0,
      revenue: sum([...revenue.values()]),
      ...getProgressTotals(courseRows, progress),
      unansweredQuestions: sum(courseResults.map((c) => c.unansweredQuestions)),
    },
    courses: courseResults,
  };
}

// ─── Revenue ───
// Sum of amounts paid (cents, PPP already applied). A team purchase is one
// purchase row; coupon redemptions have none, so purchases are never joined to
// enrollments or coupons (that would count a team purchase once per seat).

function getRevenueByCourse(instructorId: number) {
  const rows = db
    .select({
      courseId: purchases.courseId,
      revenue: sql<number>`sum(${purchases.amountPaid})`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(inScope(instructorId))
    .groupBy(purchases.courseId)
    .all();
  return new Map<number, number>(rows.map((r) => [r.courseId, r.revenue]));
}

// ─── Completion and progress ───
// Average progress mirrors calculateProgress(userId, courseId, false, false),
// the Student Roster's Progress column: completed lessons ÷ course lessons,
// rounded to a whole percent per student, 0 for a course with no lessons.

type ProgressRow = { completed: number; avgProgress: number | null };

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function getProgressByCourse(instructorId: number) {
  const lessonTotals = db
    .select({
      courseId: modules.courseId,
      total: sql<number>`count(${lessons.id})`.as("total"),
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .groupBy(modules.courseId)
    .as("lesson_totals");

  // count(*) rather than distinct lessons, matching calculateProgress.
  const completedLessons = db
    .select({
      userId: lessonProgress.userId,
      courseId: modules.courseId,
      completed: sql<number>`count(*)`.as("completed"),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessonProgress.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(lessonProgress.status, LessonProgressStatus.Completed))
    .groupBy(lessonProgress.userId, modules.courseId)
    .as("completed_lessons");

  // cast(x + 0.5 as integer) is Math.round for the non-negative values here.
  const studentProgress = sql`case
    when coalesce(${lessonTotals.total}, 0) = 0 then 0
    else cast(
      (coalesce(${completedLessons.completed}, 0) * 1.0 / ${lessonTotals.total}) * 100 + 0.5
      as integer)
  end`;

  const rows = db
    .select({
      courseId: enrollments.courseId,
      completed: sql<number>`count(${enrollments.completedAt})`,
      avgProgress: sql<number | null>`avg(${studentProgress})`,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .leftJoin(lessonTotals, eq(lessonTotals.courseId, enrollments.courseId))
    .leftJoin(
      completedLessons,
      and(
        eq(completedLessons.userId, enrollments.userId),
        eq(completedLessons.courseId, enrollments.courseId)
      )
    )
    .where(inScope(instructorId))
    .groupBy(enrollments.courseId)
    .all();
  return new Map<number, ProgressRow>(rows.map((r) => [r.courseId, r]));
}

function getCourseProgressMetrics(
  course: { id: number; enrollments: number },
  progress: Map<number, ProgressRow>
) {
  const row = progress.get(course.id);
  return {
    completionRate: ratio(row?.completed ?? 0, course.enrollments),
    avgProgress: row?.avgProgress ?? null,
  };
}

function getProgressTotals(
  courseRows: { id: number; enrollments: number }[],
  progress: Map<number, ProgressRow>
) {
  let enrolled = 0;
  let completed = 0;
  for (const course of courseRows) {
    enrolled += course.enrollments;
    completed += progress.get(course.id)?.completed ?? 0;
  }
  return { completionRate: ratio(completed, enrolled) };
}
