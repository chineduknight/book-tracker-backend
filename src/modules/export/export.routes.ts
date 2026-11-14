import { Router, type Request, type RequestHandler, type Response } from 'express';
import { parseRequestQuery } from '../../shared/request-validation.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import type { Download } from './export.dto.js';
import type { ExportLimits } from './export.limits.js';
import { exportQuerySchema } from './export.schema.js';
import {
  buildArchiveDownload,
  buildBooksCsvDownload,
  buildLoansCsvDownload,
  buildNotesMarkdownDownload,
  buildReadingSessionsCsvDownload,
  type ExportRequest,
} from './export.service.js';

export interface ExportRouterDependencies {
  requireAuthenticatedUser: RequestHandler;
  limits: ExportLimits;
}

type DownloadBuilder = (request: ExportRequest) => Promise<Download>;

const DOWNLOADS: Record<string, DownloadBuilder> = {
  '/archive': buildArchiveDownload,
  '/books.csv': buildBooksCsvDownload,
  '/reading-sessions.csv': buildReadingSessionsCsvDownload,
  '/loans.csv': buildLoansCsvDownload,
  '/notes.md': buildNotesMarkdownDownload,
};

function sendDownload(res: Response, { filename, contentType, body }: Download): void {
  res
    .status(200)
    .set('Content-Type', contentType)
    .set('Content-Disposition', `attachment; filename="${filename}"`)
    .send(body);
}

/** Each download is built completely, within the limits, before any header or byte is sent. */
export function createExportRouter({
  requireAuthenticatedUser,
  limits,
}: ExportRouterDependencies): Router {
  const exportRouter = Router();

  exportRouter.use(requireAuthenticatedUser);

  for (const [path, buildDownload] of Object.entries(DOWNLOADS)) {
    exportRouter.get(path, async (req: Request, res) => {
      parseRequestQuery(exportQuerySchema, req.query);
      const download = await buildDownload({
        ownerId: authenticatedUserOf(req).userId,
        exportedAt: new Date(),
        limits,
      });
      sendDownload(res, download);
    });
  }

  return exportRouter;
}
