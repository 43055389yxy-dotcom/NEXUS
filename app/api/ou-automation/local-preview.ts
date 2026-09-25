import type { ChatGPTUser } from '../../chatgpt-auth';
import { proxyLocalBroker } from '../broker';

export function localOuAutomationPreview(user: ChatGPTUser, body?: Record<string, unknown>) {
  return proxyLocalBroker('/ou-automation', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: 'GET' }, user);
}
