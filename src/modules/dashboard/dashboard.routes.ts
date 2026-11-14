import { Router, type Request, type RequestHandler } from 'express';
import { parseRequestQuery } from '../../shared/request-validation.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import type {
  DashboardSummaryResponseBody,
  ReadingStatisticsResponseBody,
  RecentActivityResponseBody,
} from './dashboard.dto.js';
import {
  readingStatisticsQuerySchema,
  recentActivityQuerySchema,
  summaryQuerySchema,
} from './dashboard.schema.js';
import {
  findDashboardSummary,
  findReadingStatistics,
  findRecentActivity,
} from './dashboard.service.js';

export interface DashboardRouterDependencies {
  requireAuthenticatedUser: RequestHandler;
}

function ownerIdOf(req: Request): string {
  return authenticatedUserOf(req).userId;
}

export function createDashboardRouter({
  requireAuthenticatedUser,
}: DashboardRouterDependencies): Router {
  const dashboardRouter = Router();

  dashboardRouter.use(requireAuthenticatedUser);

  dashboardRouter.get('/summary', async (req, res) => {
    const summaryQuery = parseRequestQuery(summaryQuerySchema, req.query);
    const summary = await findDashboardSummary(ownerIdOf(req), summaryQuery);
    res.status(200).json({ data: summary } satisfies DashboardSummaryResponseBody);
  });

  dashboardRouter.get('/reading-statistics', async (req, res) => {
    parseRequestQuery(readingStatisticsQuerySchema, req.query);
    const statistics = await findReadingStatistics(ownerIdOf(req));
    res.status(200).json({ data: statistics } satisfies ReadingStatisticsResponseBody);
  });

  dashboardRouter.get('/recent-activity', async (req, res) => {
    const activityQuery = parseRequestQuery(recentActivityQuerySchema, req.query);
    const activities = await findRecentActivity(ownerIdOf(req), activityQuery);
    res.status(200).json({ data: activities } satisfies RecentActivityResponseBody);
  });

  return dashboardRouter;
}
