export interface RunbookTopic {
  topic: string
  steps: string[]
  notes: string[]
}

const RUNBOOKS: Record<string, RunbookTopic> = {
  OTA升级: {
    topic: 'OTA升级',
    steps: [
      '确认目标版本与 slot（A/B），核对 manifest/校验和',
      '传输大包到机器人（rsync 或三跳中继）',
      '以 nvidia 用户解压/执行 bash awr_*.run（禁止 sudo）',
      '重启节点 start_awr.sh，验证 ps aux | grep mainboard ≥6',
      '验证版本号与 A/B slot 切换结果，写审计',
    ],
    notes: [
      'tars_flash 烧录、systemctl、写系统路径例外可用 sudo',
      '刷大包前确认机器人在可停状态，避免半包',
    ],
  },
  机器人轮换: {
    topic: '机器人轮换',
    steps: [
      '下线旧机器人：停 job、确认安全状态',
      '新机器人入列：网络/ehmi 连接、bindmap 换绑',
      '跑健康检查 health（进程数/节点状态/版本）',
      '校准/质检（串行，逐项执行）',
      '切流量到新机器人，旧机器人回收',
    ],
    notes: ['换绑/质检走 ehmi_client.py，禁止新脚本直连 WebSocket'],
  },
  传感器故障: {
    topic: '传感器故障',
    steps: [
      'investigate 抓取 /apollo/data/log 中该传感器上报',
      '定位故障类型（F/T 传感器 / 视觉 / 内窥镜）与工位',
      '确认对应工位灯黄闪（停线态）',
      '按工位规则处置：复位/换件/标定',
      '恢复后跑质检确认 std 值达标，report 归档',
    ],
    notes: ['质检必须输出详细数据（std mm、validate_success、耗时），不能只写 pass/fail'],
  },
  AIO群控: {
    topic: 'AIO群控',
    steps: [
      '确认群控目标（多机轮换/批量升级/批量质检）',
      '用 AwrStRunTool 的 swarm/team 并发编排多机',
      '每机独立 ssh 会话 + 独立审计',
      '聚合结果写 report',
    ],
    notes: ['多机操作复用 AwrStRunTool，不在 sretool 里重造并发编排'],
  },
  Thor部署: {
    topic: 'Thor部署',
    steps: [
      '查 AwrOpsTool 的 guide/script 拿板载编译/部署步骤',
      'rsync/三跳中继传输产物到 Thor 板',
      '按 A/B slot 切换策略刷写/部署',
      '跑 Gate-1 E2E 验证',
      '写审计 + report',
    ],
    notes: ['部署细节以 AwrOpsTool 资产为准，sretool 只做编排与护栏'],
  },
}

export function listRunbookTopics(): string[] {
  return Object.keys(RUNBOOKS)
}

export function getRunbook(topic: string): RunbookTopic | null {
  const exact = RUNBOOKS[topic]
  if (exact) return exact
  // Fuzzy: match the first topic whose key includes the query or vice versa.
  const keys = Object.keys(RUNBOOKS)
  const hit = keys.find(k => k.includes(topic) || topic.includes(k))
  return hit ? RUNBOOKS[hit] : null
}

export function formatRunbook(rb: RunbookTopic): string {
  const lines = [`# ${rb.topic}`, '']
  rb.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
  if (rb.notes.length) {
    lines.push('', 'Notes:')
    rb.notes.forEach(n => lines.push(`- ${n}`))
  }
  return lines.join('\n')
}
