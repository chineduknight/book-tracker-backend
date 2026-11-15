import { request, type IncomingHttpHeaders } from 'node:http';

export interface PlainResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A plain HTTP request with exactly the given headers, as a client on the internet would send. */
export function sendRequest(
  url: string,
  {
    method = 'GET',
    headers = {},
    body,
  }: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<PlainResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method, headers, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
