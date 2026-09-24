import { getChatGPTUser, isAdminRole } from '../../chatgpt-auth';
import { CreditAccountDashboard } from './credit-account-dashboard';

export const dynamic = 'force-dynamic';

export default async function CreditMonitorAccountPage({ params }: { params: Promise<{ accountId: string }> }) {
  const user = await getChatGPTUser();
  const { accountId } = await params;
  return <CreditAccountDashboard accountId={accountId} canSync={Boolean(user && isAdminRole(user.role))} />;
}
