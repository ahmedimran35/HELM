// Thin typed fetch wrapper. All API calls go through here so:
//   1. We have ONE place to read the cookie (credentials: "include")
//   2. We have ONE place to handle 401 → kick back to login
//   3. We have ONE place to handle 403 → show a "forbidden" state
// No state, no caching — keep it boring.

export interface ApiError extends Error {
  status: number;
  body: unknown;
}

function makeError(status: number, body: unknown): ApiError {
  const e = new Error(
    typeof body === "object" && body && "error" in body
      ? String((body as { error: unknown }).error)
      : `request failed: ${status}`,
  ) as ApiError;
  e.status = status;
  e.body = body;
  return e;
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  // Don't set Content-Type when the caller passes FormData (multipart
  // uploads); the browser must set the boundary itself. Also skip the
  // default JSON Content-Type when the caller explicitly passes a body
  // of type ReadableStream / Blob / FormData via init.body.
  const isMultipart =
    typeof FormData !== "undefined" && init.body instanceof FormData;
  const isStream =
    typeof ReadableStream !== "undefined" && init.body instanceof ReadableStream;
  const isBlob = typeof Blob !== "undefined" && init.body instanceof Blob;
  const baseHeaders: Record<string, string> = isMultipart || isStream || isBlob
    ? {}
    : { "Content-Type": "application/json" };
  const headers: Record<string, string> = {
    ...baseHeaders,
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    // Only fire the "unauthenticated" event when the failure is actually
    // a session problem. Endpoints that return 401 for *other* reasons
    // (e.g. step-up required for the audit log viewer, or a missing
    // permission) must NOT kick the user back to /login — that creates
    // an infinite redirect loop. We inspect the parsed body for the
    // known "real session" error codes before signalling.
    if (res.status === 401) {
      const code = typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : "";
      const isSessionProblem =
        code === "unauthenticated" ||
        code === "session_expired" ||
        code === "" || // plain 401 with no body — treat as session
        !code;
      if (isSessionProblem) {
        window.dispatchEvent(new CustomEvent("helm:unauthenticated"));
      }
    }
    if (res.status === 403) {
      window.dispatchEvent(new CustomEvent("helm:forbidden"));
    }
    throw makeError(res.status, body);
  }
  return body as T;
}

export const apiGet = <T>(path: string) => api<T>(path);
export const apiPost = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export const apiPatch = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export const apiPut = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: "PUT",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export const apiDelete = <T>(path: string) => api<T>(path, { method: "DELETE" });