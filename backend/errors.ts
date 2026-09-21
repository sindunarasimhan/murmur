export class ServiceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export const missing = () => new ServiceError(404, 'not_found', 'This listening session could not be found.');
export const stale = () => new ServiceError(409, 'stale_session', 'Playback changed. Please try that request again.');
