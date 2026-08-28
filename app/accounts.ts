export type AccessLevel = 'admin' | 'billing' | 'readonly';

export type CloudAccount = {
  id: string;
  name: string;
  organization: string;
  region: string;
  roleName: string;
  access: AccessLevel;
  environment: 'production' | 'shared' | 'audit';
  favorite: boolean;
  lastUsed: string;
};

const customerNames = [
  '青岚科技', '拓海数据', '辰星互动', '云杉智造', '远舟物流',
  '白鹭零售', '恒川能源', '澄明网络', '深湾传媒', '启元生物',
  '北辰教育', '新禾电商', '安澜出行', '格物软件', '山海文旅',
  '凌云智能', '墨川设计', '知行咨询', '鸣沙游戏', '长风医疗',
  '若水金融', '光屿影业', '千帆出海', '森罗物联', '星野农业',
  '东篱食品', '原点机器人', '叠川建筑', '云雀通信', '微澜材料',
  '银河互娱', '柏舟安全', '开物科技', '极昼数据', '南山贸易',
  '云图测绘', '晨曦半导体', '海岳供应链', '磐石工业', '青禾健康',
  '鲸落内容', '见山汽车', '桥渡支付', '拾光生活', '苍穹航空',
  '沐风家居', '原野宠物', '镜湖信息', '玄鸟数字', '川流服务',
  '大象云服', '松间文创', '灯塔科技', '脉冲网络', '灵犀软件',
  '飞鸟国际', '地平线数据', '行远供应链', '边界智能', '群岛互联',
];

const regions = ['ap-southeast-1', 'ap-northeast-1', 'us-east-1', 'eu-west-1'];

export const cloudAccounts: CloudAccount[] = customerNames.map((name, index) => {
  const access: AccessLevel = index % 11 === 0 ? 'billing' : index % 7 === 0 ? 'readonly' : 'admin';
  const environment = access === 'readonly' ? 'audit' : index % 5 === 0 ? 'shared' : 'production';
  const roleName = access === 'admin'
    ? 'OperationsOperatorRole'
    : access === 'billing'
      ? 'BillingReadOnlyRole'
      : 'SecurityAuditRole';

  return {
    id: String(110000000001 + index * 7919).padStart(12, '0'),
    name,
    organization: `${name}独立组织`,
    region: regions[index % regions.length],
    roleName,
    access,
    environment,
    favorite: index < 5 || index === 11 || index === 18,
    lastUsed: index < 3 ? `${index + 2} 分钟前` : index < 12 ? `${index} 小时前` : '本月未访问',
  };
});

export function findCloudAccount(accountId: string, roleName: string) {
  return cloudAccounts.find((account) => account.id === accountId && account.roleName === roleName);
}
