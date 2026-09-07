import type { ChatGPTUser } from '../../chatgpt-auth';
import { proxyLocalBroker } from '../broker';

type LocalRequest = { action?: string; accountId?: string; memberAccountId?: string; destination?: string };

export function localOuAutomationPreview(user: ChatGPTUser, body?: LocalRequest) {
  return proxyLocalBroker('/ou-automation', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: 'GET' }, user);
}
