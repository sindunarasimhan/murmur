export const MURMUR_CLIENT_HEADER = 'X-Murmur-Client';
export const MURMUR_CLIENT_HEADER_VALUE = 'expo';

export function isMurmurClientRequest(request: Request): boolean {
  return request.headers.get(MURMUR_CLIENT_HEADER) === MURMUR_CLIENT_HEADER_VALUE;
}
