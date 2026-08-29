import { getChatGPTUser } from './chatgpt-auth';
import { CloudAccessDashboard } from './cloud-access-dashboard';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await getChatGPTUser();
  return <CloudAccessDashboard userName={user?.displayName ?? ''} userRole={user?.role ?? 'user'} />;
}
