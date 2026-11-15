import type { Express } from 'express';
import { API_PREFIX } from '../src/app.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** `METHOD /api/v1/path/:param`, exactly as the route is registered. */
export type RouteKey = `${HttpMethod} ${string}`;

/** Routes anyone may call; every other route must require a valid access token. */
export const PUBLIC_ROUTES: readonly RouteKey[] = [
  'GET /api/v1/health',
  'GET /api/v1/ready',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
];

/** Every route serving or changing a reader's data. A new route must be added here deliberately. */
export const PRIVATE_ROUTES: readonly RouteKey[] = [
  'GET /api/v1/auth/me',
  'POST /api/v1/books',
  'GET /api/v1/books',
  'GET /api/v1/books/duplicate-check',
  'GET /api/v1/books/:bookId',
  'PATCH /api/v1/books/:bookId',
  'DELETE /api/v1/books/:bookId',
  'GET /api/v1/books/:bookId/organization',
  'POST /api/v1/locations',
  'GET /api/v1/locations',
  'GET /api/v1/locations/:locationId',
  'PATCH /api/v1/locations/:locationId',
  'POST /api/v1/books/:bookId/copies',
  'GET /api/v1/books/:bookId/copies',
  'GET /api/v1/copies/:copyId',
  'PATCH /api/v1/copies/:copyId',
  'DELETE /api/v1/copies/:copyId',
  'POST /api/v1/books/:bookId/reading-sessions',
  'GET /api/v1/books/:bookId/reading-sessions',
  'GET /api/v1/books/:bookId/reading-overview',
  'GET /api/v1/reading-sessions',
  'GET /api/v1/reading-sessions/:sessionId',
  'PATCH /api/v1/reading-sessions/:sessionId',
  'POST /api/v1/books/:bookId/notes',
  'GET /api/v1/books/:bookId/notes',
  'GET /api/v1/notes',
  'GET /api/v1/notes/:noteId',
  'PATCH /api/v1/notes/:noteId',
  'DELETE /api/v1/notes/:noteId',
  'GET /api/v1/categories/presets',
  'POST /api/v1/categories',
  'GET /api/v1/categories',
  'GET /api/v1/categories/:categoryId',
  'PATCH /api/v1/categories/:categoryId',
  'DELETE /api/v1/categories/:categoryId',
  'PUT /api/v1/categories/:categoryId/books/:bookId',
  'DELETE /api/v1/categories/:categoryId/books/:bookId',
  'GET /api/v1/categories/:categoryId/books',
  'POST /api/v1/collections',
  'GET /api/v1/collections',
  'GET /api/v1/collections/:collectionId',
  'PATCH /api/v1/collections/:collectionId',
  'DELETE /api/v1/collections/:collectionId',
  'PUT /api/v1/collections/:collectionId/books/:bookId',
  'DELETE /api/v1/collections/:collectionId/books/:bookId',
  'GET /api/v1/collections/:collectionId/books',
  'POST /api/v1/wishlist',
  'GET /api/v1/wishlist',
  'GET /api/v1/wishlist/:wishlistItemId',
  'PATCH /api/v1/wishlist/:wishlistItemId',
  'PUT /api/v1/wishlist/:wishlistItemId/acquisition',
  'DELETE /api/v1/wishlist/:wishlistItemId',
  'POST /api/v1/copies/:copyId/loans',
  'GET /api/v1/copies/:copyId/loans',
  'GET /api/v1/copies/:copyId/loan-overview',
  'GET /api/v1/loans',
  'GET /api/v1/loans/:loanId',
  'PATCH /api/v1/loans/:loanId',
  'PUT /api/v1/loans/:loanId/return',
  'GET /api/v1/dashboard/summary',
  'GET /api/v1/dashboard/reading-statistics',
  'GET /api/v1/dashboard/recent-activity',
  'GET /api/v1/export/archive',
  'GET /api/v1/export/books.csv',
  'GET /api/v1/export/reading-sessions.csv',
  'GET /api/v1/export/loans.csv',
  'GET /api/v1/export/notes.md',
];

/** Mount paths used in `app.ts`. Express keeps no mount path on a layer, only a matcher. */
const MOUNT_PATHS = [
  '/auth',
  '/books',
  '/locations',
  '/categories',
  '/collections',
  '/wishlist',
  '/dashboard',
  '/export',
];

interface RouterLayer {
  slash: boolean;
  match(path: string): boolean;
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: RouterLayer[] };
}

function mountPathOf(layer: RouterLayer, parentPath: string): string {
  if (layer.slash) return parentPath;
  const mountPath = MOUNT_PATHS.find((candidate) => layer.match(candidate));
  if (mountPath === undefined) throw new Error(`a router under ${parentPath} has an unknown mount`);
  return `${parentPath}${mountPath}`;
}

function routesIn(layers: RouterLayer[], parentPath: string): RouteKey[] {
  return layers.flatMap((layer) => {
    if (layer.route) {
      const { path, methods } = layer.route;
      const fullPath = path === '/' ? parentPath : `${parentPath}${path}`;
      return Object.keys(methods).map(
        (method) => `${method.toUpperCase() as HttpMethod} ${fullPath}` as const,
      );
    }
    if (!layer.handle.stack) return [];
    return routesIn(layer.handle.stack, mountPathOf(layer, parentPath));
  });
}

/** Every method and path the application registers under the API prefix, from its router. */
export function registeredRoutesOf(app: Express): RouteKey[] {
  const { stack } = (app as unknown as { router: { stack: RouterLayer[] } }).router;
  const apiRouter = stack.find((layer) => !layer.slash && layer.match(API_PREFIX));
  if (!apiRouter?.handle.stack) throw new Error(`no router is mounted at ${API_PREFIX}`);
  return routesIn(apiRouter.handle.stack, API_PREFIX);
}

export function methodOf(route: RouteKey): HttpMethod {
  return route.slice(0, route.indexOf(' ')) as HttpMethod;
}

export function pathTemplateOf(route: RouteKey): string {
  return route.slice(route.indexOf(' ') + 1);
}

/** Names of the route's path parameters, in order. */
export function parametersOf(route: RouteKey): string[] {
  return [...pathTemplateOf(route).matchAll(/:(\w+)/g)].map(([, name]) => name ?? '');
}

/** The route's path with every parameter replaced by `fill(name)`. */
export function pathOf(route: RouteKey, fill: (parameter: string) => string): string {
  return pathTemplateOf(route).replace(/:(\w+)/g, (_match, name: string) => fill(name));
}

export function isWriteRoute(route: RouteKey): boolean {
  return ['POST', 'PUT', 'PATCH'].includes(methodOf(route));
}
