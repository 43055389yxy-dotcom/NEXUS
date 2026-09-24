import { getChatGPTUser, isAdminRole } from '../chatgpt-auth';
import { CreditMonitorDashboard } from './credit-monitor-dashboard';

export const dynamic = 'force-dynamic';

export default async function CreditMonitorPage() {
  const user = await getChatGPTUser();
  return <CreditMonitorDashboard canSync={Boolean(user && isAdminRole(user.role))} />;
}
