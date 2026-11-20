import type { ReactNode } from "react";
import { Link, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.analytics";
import { requireInstructor } from "~/lib/access.server";
import { getInstructorAnalytics } from "~/services/instructorAnalyticsService";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  DollarSign,
  MessageSquare,
  Users,
} from "lucide-react";
import { CourseStatus } from "~/db/schema";
import { formatPrice } from "~/lib/utils";

export function meta() {
  return [
    { title: "Analytics — Cadence" },
    { name: "description", content: "How your courses are doing" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { userId } = await requireInstructor(request);
  return getInstructorAnalytics(userId);
}

/** Metrics with no data are `null` and render as "—". */
function formatMetric<T>(
  value: T | null,
  format: (value: T) => string = String
): string {
  return value === null ? "—" : format(value);
}

/** Rates, progress and quiz scores are all 0–1 fractions. */
function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** formatPrice, except zero revenue is "$0.00" rather than "Free". */
function formatRevenue(cents: number): string {
  return cents === 0 ? "$0.00" : formatPrice(cents);
}

function formatRating(rating: { average: number | null; count: number }) {
  return formatMetric(
    rating.average,
    (average) => `${average.toFixed(1)} (${rating.count})`
  );
}

function HeadlineCard({
  label,
  value,
  icon,
  to,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  to?: string;
}) {
  const card = (
    <Card
      className={to ? "h-full transition-colors hover:bg-muted/30" : undefined}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );

  return to ? <Link to={to}>{card}</Link> : card;
}

const thClass =
  "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";
const tdClass = "px-4 py-3 text-sm";

export default function InstructorAnalytics({
  loaderData,
}: Route.ComponentProps) {
  const { totals, courses } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      {/* Breadcrumb */}
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Analytics</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Analytics</h1>
        <p className="mt-1 text-muted-foreground">
          A snapshot of your published and archived courses
        </p>
      </div>

      {courses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <BarChart3 className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">Nothing to report yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Analytics appear once you have a published or archived course.
          </p>
          <Link to="/instructor" className="mt-4">
            <Button>Go to My Courses</Button>
          </Link>
        </div>
      ) : (
        <>
          <div className="mb-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <HeadlineCard
              label="Unique students"
              value={formatMetric(totals.uniqueStudents)}
              icon={<Users className="size-4 text-muted-foreground" />}
            />
            <HeadlineCard
              label="Total revenue"
              value={formatRevenue(totals.revenue)}
              icon={<DollarSign className="size-4 text-muted-foreground" />}
            />
            <HeadlineCard
              label="Completion rate"
              value={formatMetric(totals.completionRate, formatPercent)}
              icon={<CheckCircle2 className="size-4 text-muted-foreground" />}
            />
            <HeadlineCard
              label="Unanswered questions"
              value={formatMetric(totals.unansweredQuestions)}
              icon={<MessageSquare className="size-4 text-muted-foreground" />}
              to="/instructor/questions"
            />
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className={thClass}>Course</th>
                      <th className={thClass}>Enrollments</th>
                      <th className={thClass}>Completion rate</th>
                      <th className={thClass}>Avg progress</th>
                      <th className={thClass}>Revenue</th>
                      <th className={thClass}>Rating</th>
                      <th className={thClass}>Avg best quiz score</th>
                      <th className={thClass}>Avg first quiz score</th>
                      <th className={thClass}>Unanswered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {courses.map((course) => (
                      <tr
                        key={course.id}
                        className="border-b border-border last:border-0 hover:bg-muted/30"
                      >
                        <td className={tdClass}>
                          <div className="flex items-center gap-2">
                            <Link
                              to={`/instructor/${course.id}/students`}
                              className="font-medium hover:text-primary"
                            >
                              {course.title}
                            </Link>
                            {course.status === CourseStatus.Archived && (
                              <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:bg-gray-900/30 dark:text-gray-400">
                                Archived
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={tdClass}>
                          {formatMetric(course.enrollments)}
                        </td>
                        <td className={tdClass}>
                          {formatMetric(course.completionRate, formatPercent)}
                        </td>
                        <td className={tdClass}>
                          {formatMetric(course.avgProgress, formatPercent)}
                        </td>
                        <td className={tdClass}>
                          {formatRevenue(course.revenue)}
                        </td>
                        <td className={tdClass}>
                          {formatRating(course.rating)}
                        </td>
                        <td className={tdClass}>
                          {formatMetric(course.avgBestQuizScore, formatPercent)}
                        </td>
                        <td className={tdClass}>
                          {formatMetric(
                            course.avgFirstQuizScore,
                            formatPercent
                          )}
                        </td>
                        <td className={tdClass}>
                          {formatMetric(course.unansweredQuestions)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

const ERROR_TITLES: Record<number, string> = {
  401: "Sign in required",
  403: "Access denied",
};

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your analytics.";

  if (isRouteErrorResponse(error)) {
    title = ERROR_TITLES[error.status] ?? `Error ${error.status}`;
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/courses">
            <Button variant="outline">Browse Courses</Button>
          </Link>
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
