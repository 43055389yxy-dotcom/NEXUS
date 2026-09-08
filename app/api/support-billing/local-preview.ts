import type { ChatGPTUser } from '../../chatgpt-auth';
import { proxyLocalBroker } from '../broker';

export type LocalRequest = { action?: string; accountId?: string; targetAccountId?: string; enabled?: boolean; period?: string; targets?: string[] };

export function localSupportBillingPreview(user: ChatGPTUser, body?: LocalRequest) {
  return proxyLocalBroker('/support-billing', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: 'GET' }, user);
}
