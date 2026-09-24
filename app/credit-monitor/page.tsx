import { getChatGPTUser } from '../chatgpt-auth';
import { CreditMonitorDashboard } from './credit-monitor-dashboard';

export const dynamic = 'force-dynamic';

export default async function CreditMonitorPage() {
  await getChatGPTUser();
  return <CreditMonitorDashboard />;
}
