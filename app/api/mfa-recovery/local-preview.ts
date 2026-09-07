import { NextResponse } from 'next/server';

export function localMfaRecoveryPreview(body: Record<string, unknown>) {
  const action = String(body.action ?? '');
  if (action === 'organization-status' || action === 'preflight') return NextResponse.json({ preview: true, preflight: { organization: { managementAccountId: String(body.payerAccountId ?? '') }, target: { accountId: String(body.memberAccountId ?? ''), name: '本地预览账号', state: 'ACTIVE' }, rootAccess: { trustedAccessEnabled: true, rootSessionsEnabled: true, rootCredentialsManagementEnabled: true } } });
  if (action === 'root-status') return NextResponse.json({ preview: true, status: { passwordPresent: true, accessKeys: [], signingCertificates: [], mfaDevices: [{ serialNumber: '本地预览 MFA' }] } });
  if (action === 'root-delete') return NextResponse.json({ preview: true, changes: ['已停用根用户 MFA', '已删除根用户密码'], status: { passwordPresent: false, accessKeys: [], signingCertificates: [], mfaDevices: [] } });
  if (action === 'root-recover') return NextResponse.json({ preview: true, changes: ['已允许通过根邮箱重置密码'] });
  return NextResponse.json({ error: '不支持的恢复操作' }, { status: 400 });
}
