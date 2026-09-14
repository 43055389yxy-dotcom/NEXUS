import { getChatGPTUser } from '../chatgpt-auth';
import { ApnMonitorDashboard } from './apn-monitor-dashboard';

export const dynamic = 'force-dynamic';

export default async function ApnMonitorPage() {
  const user = await getChatGPTUser();
  return <ApnMonitorDashboard userName={user?.displayName ?? ''} />;
}
