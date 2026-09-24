import { getChatGPTUser } from '../../chatgpt-auth';
import { CreditAccountDashboard } from './credit-account-dashboard';

export const dynamic = 'force-dynamic';

export default async function CreditMonitorAccountPage({ params }: { params: Promise<{ accountId: string }> }) {
  await getChatGPTUser();
  const { accountId } = await params;
  return <CreditAccountDashboard accountId={accountId} />;
}
