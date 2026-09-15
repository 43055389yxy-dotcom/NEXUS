import { getChatGPTUser } from '../chatgpt-auth';
import { SupportCaseMonitorDashboard } from './support-case-monitor-dashboard';

export const dynamic = 'force-dynamic';

export default async function SupportCaseMonitorPage() {
  const user = await getChatGPTUser();
  return <SupportCaseMonitorDashboard userName={user?.displayName ?? ''} />;
}
