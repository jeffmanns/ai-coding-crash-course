import { and, countDistinct, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  CourseStatus,
  enrollments,
  lessons,
  modules,
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
  unansweredQuestions: number;
};

export type InstructorCourseAnalytics = {
  id: number;
  title: string;
  status: CourseStatus;
  enrollments: number;
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
      attemptOrder: sql<number>`row_number() over (${pair} order by ${quizAttempts.attemptedAt}, ${quizAttempts.id})`.as(
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
    averages.set(row.courseId, { avgBest: row.avgBest, avgFirst: row.avgFirst });
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

  const courseIds = courseRows.map((row) => row.id);
  const ratings = getCourseRatingSummaries(courseIds);
  const unanswered = countUnansweredByCourse(instructorId);
  const quizScores = getQuizScoreAverages(courseIds);

  const courseResults = courseRows.map((row) => ({
    ...row,
    rating: ratings.get(row.id)!,
    unansweredQuestions: unanswered.get(row.id) ?? 0,
    avgBestQuizScore: quizScores.get(row.id)?.avgBest ?? null,
    avgFirstQuizScore: quizScores.get(row.id)?.avgFirst ?? null,
  }));

  return {
    totals: {
      uniqueStudents: totalsRow?.uniqueStudents ?? 0,
      unansweredQuestions: sum(courseResults.map((c) => c.unansweredQuestions)),
    },
    courses: courseResults,
  };
}
