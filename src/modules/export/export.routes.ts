import { Router, type Request, type RequestHandler, type Response } from 'express';
import { parseRequestQuery } from '../../shared/request-validation.js';
import { unauthenticatedError } from '../auth/auth.errors.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import type { UserDto } from '../users/user.dto.js';
import { findUserById } from '../users/user.service.js';
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

/*
 * Authentication proves the session, not that the account still exists. Every download checks
 * the account first, so a reader deleted while a session is still active receives nothing.
 */
async function exportingProfileOf(req: Request, res: Response): Promise<UserDto> {
  const profile = await findUserById(authenticatedUserOf(req).userId);
  if (profile) return profile;
  res.set('WWW-Authenticate', 'Bearer');
  throw unauthenticatedError();
}

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
      const profile = await exportingProfileOf(req, res);
      parseRequestQuery(exportQuerySchema, req.query);
      const download = await buildDownload({ profile, exportedAt: new Date(), limits });
      sendDownload(res, download);
    });
  }

  return exportRouter;
}
