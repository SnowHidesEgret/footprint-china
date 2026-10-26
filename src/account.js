/**
 * 点亮中国 · v2 账号切换与退出模块
 *
 * 设计说明（回应多用户切换与安全边界）：
 * 1. 本机「曾登录账号」列表（localStorage `footprint.accounts.v2`）只保存
 *    `{ type, username/guestId, nickname, lastUsedAt }` 白名单字段，绝不保存密码、PIN 或哈希。
 * 2. 为什么切换到另一注册账号时仍要求输入 4 位数字密码：
 *    - 当前 v2 会话本质上只是 localStorage 里的一条 `{ type, username, nickname }` 记录，
 *      服务端未签发带过期时间的 session token；
 *    - 一家人共用一台平板/电脑时，若允许免密一键切换注册账号，任何人（包括误触的孩子）
 *      点一下就能改动他人足迹、退出他人房间甚至重设房主密码，既无安全边界也极易串号；
 *    - 4 位数字密码输入成本极低（点账号自动填好用户名并聚焦密码框，仅需按 4 下数字键），
 *      既能防止家人误点串号，也诚实面对「本地无服务端 token」的架构现状。
 * 3. 游客与注册账号互切：
 *    - 游客足迹只保存在本机 `footprint.guest.fp.v2.<guestId>`，无密码可验；
 *    - 切走或退出前，先通过 `flushSync` 把游客足迹落盘，再用 `rememberAccount` 记入本机列表
 *      （`getKnownAccounts` 只展示点亮过数据的游客档案，避免空白试玩刷屏）；
 *    - 之后从列表点该游客即可一键恢复；而点底部「游客试玩」始终新建空白游客，绝不泄露上一人的足迹。
 * 4. 防串号与失败回滚：
 *    - 认证请求在 `auth-ui.js` 内完成，密码错误或网络失败时不会调用 `commitSession`，
 *      原会话与本地 Store 原封不动；
 *    - `commitSession` 先 `flushSync(store)` 保存旧账号未同步改动，再 `pauseSync(true)` 冻结同步，
 *      随后先用新账号云端/游客档案覆盖本地 Store，最后写新会话并刷新页面。
 * 5. 游客转正合并（2026-10-26）：
 *    - 上一会话是游客且有足迹、新会话是注册用户时，若游客足迹里有云端还没有的新点亮，
 *      弹出确认框询问是否合并；只有用户点了「合并足迹」才上传合并结果；
 *    - 合并是并集：云端已有的项一律不覆盖（云端为准），只补游客独有的省/市/景点/记忆，
 *      成就取并集、称号等级取较大值；合并失败时跳过合并、游客档案仍保留在列表里，
 *      下次从游客切回该账号时可再合（幂等，不会重复计数）；
 *    - 游客足迹本身不删除：合并后仍可从本机列表切回游客号查看。
 */

import {
  getSession,
  saveSession,
  clearSession,
  rememberAccount,
  isGuest,
  isUser,
  getGuestFootprint,
  guestHasData,
} from './auth.js?v=20261026a';
import { flushSync, pauseSync, putUser } from './sync.js?v=20261026a';

/**
 * 提取当前会话最新昵称（若用户在大厅改过名，以 Store 中活跃用户昵称为准）
 */
function resolveSessionWithLatestName(store, session) {
  if (!session) return null;
  const activeUser = store && typeof store.getActiveUser === 'function' ? store.getActiveUser() : null;
  const latestName = (
    activeUser &&
    activeUser.userId &&
    !String(activeUser.userId).startsWith('anon_') &&
    activeUser.nickname
  )
    ? activeUser.nickname
    : session.nickname;
  return { ...session, nickname: latestName || session.username || '游客' };
}

/**
 * 足迹对象的键列表（非对象时视为空）
 */
function mapKeys(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj) : [];
}

/**
 * 游客足迹相对云端足迹的新增量：只数云端还没有的键（云端已有的不算新增，合并时也不覆盖）
 * @returns {{provinces: number, cities: number, spots: number, memos: number, total: number}}
 */
function diffGuestFootprint(guestFp, targetFp) {
  const g = guestFp || {};
  const t = targetFp || {};
  const fresh = (key) => mapKeys(g[key]).filter(
    (k) => !(t[key] && typeof t[key] === 'object' && k in t[key])
  ).length;
  const provinces = fresh('provinces');
  const cities = fresh('cities');
  const spots = fresh('spots');
  const memos = fresh('memos');
  return { provinces, cities, spots, memos, total: provinces + cities + spots + memos };
}

/**
 * 足迹并集：云端为准（冲突键保留云端值），只补游客独有的键；成就并集，称号等级取大值
 */
function unionFootprints(targetFp, guestFp) {
  const t = targetFp || {};
  const g = guestFp || {};
  const mergedSection = (key) => {
    const base = t[key] && typeof t[key] === 'object' ? t[key] : {};
    const extra = {};
    for (const k of mapKeys(g[key])) {
      if (!(k in base)) extra[k] = g[key][k];
    }
    return { ...base, ...extra };
  };
  const tAch = Array.isArray(t.unlockedAchievements) ? t.unlockedAchievements : [];
  const gAch = Array.isArray(g.unlockedAchievements) ? g.unlockedAchievements : [];
  return {
    provinces: mergedSection('provinces'),
    cities: mergedSection('cities'),
    spots: mergedSection('spots'),
    memos: mergedSection('memos'),
    unlockedAchievements: [...new Set([...tAch, ...gAch])],
    maxTitleLevel: Math.max(t.maxTitleLevel || 0, g.maxTitleLevel || 0),
  };
}

/**
 * 认证成功后提交新会话（初次登录、注册、老用户领回、切换账号、恢复游客统一走此路径）
 * @param {Object} store Store 实例
 * @param {Object} newSession 新会话 `{ type: 'user'|'guest', username?, guestId?, nickname }`
 * @param {Object|null} cloudUser 服务端返回的用户档案（注册/登录/领回时传入；游客为 null）
 * @param {{confirm?: Function, toast?: Function}} opts
 * @returns {Promise<boolean>} true = 已接手并即将刷新；false = 用户取消切换，留在原账号
 */
export async function commitSession(store, newSession, cloudUser = null, opts = {}) {
  if (!newSession || !newSession.type) return false;

  const curSession = getSession();

  // 1. 若已有活跃会话，先将其未同步改动保存（注册用户 PUT 上云，游客写本机存储）
  if (curSession && store) {
    let synced = true;
    try {
      synced = await flushSync(store);
    } catch {
      synced = false;
    }
    if (!synced && typeof opts.confirm === 'function') {
      const proceed = await opts.confirm(
        '当前账号还有未同步到云端的足迹改动，网络异常暂时无法保存。继续切换将丢失这些未同步改动，确定继续吗？',
        { confirmText: '仍要切换', danger: true, above: true }
      );
      if (!proceed) return false;
    }
  }

  // 2. 冻结自动同步与卸载同步，避免页面刷新瞬间把旧/新状态误传
  pauseSync(true);

  // 3. 记住旧会话到本机「曾登录账号」列表
  if (curSession) {
    rememberAccount(resolveSessionWithLatestName(store, curSession));
  }

  // 4. 组装新会话
  const nextSession = {
    ...newSession,
    nickname: (cloudUser && cloudUser.nickname) || newSession.nickname || newSession.username || '游客',
  };

  // 5. 游客转正合并：上一会话是游客且有足迹、新会话是注册用户时，
  //    若游客足迹里有云端还没有的新点亮，询问是否合并（见模块顶部设计说明 5）
  let mergedCloudUser = cloudUser;
  if (store && curSession && isGuest(curSession) && isUser(nextSession) && cloudUser && cloudUser.userId) {
    const guestFp = getGuestFootprint(curSession.guestId);
    if (guestHasData(curSession.guestId)) {
      const diff = diffGuestFootprint(guestFp, cloudUser.footprint || {});
      if (diff.total > 0 && typeof opts.confirm === 'function') {
        const parts = [];
        if (diff.provinces) parts.push(`${diff.provinces} 省`);
        if (diff.cities) parts.push(`${diff.cities} 市`);
        if (diff.spots) parts.push(`${diff.spots} 个景点`);
        if (diff.memos) parts.push(`${diff.memos} 条记忆`);
        const guestName = curSession.nickname || '游客';
        const proceed = await opts.confirm(
          `游客「${guestName}」有 ${parts.join('、')} 是「${nextSession.nickname}」还没有的，是否合并进来？合并后游客档案仍保留，可随时切回查看。`,
          { confirmText: '合并足迹', above: true }
        );
        if (proceed) {
          const mergedFp = unionFootprints(cloudUser.footprint || {}, guestFp);
          let ok = false;
          try {
            ok = await putUser(nextSession.username, { footprint: mergedFp });
          } catch {
            ok = false;
          }
          if (ok) {
            mergedCloudUser = { ...cloudUser, footprint: mergedFp };
          } else if (typeof opts.toast === 'function') {
            opts.toast('网络异常，足迹合并未完成；游客档案仍保留，下次切换时可再合并');
          }
        }
      }
    }
  }

  // 6. 用新账号档案覆盖本地 Store（防止刷新后因网络抖动残留旧账号数据）
  if (store) {
    if (isGuest(nextSession)) {
      store.applyGuestProfile(nextSession, getGuestFootprint(nextSession.guestId));
    } else if (isUser(nextSession) && mergedCloudUser && mergedCloudUser.userId) {
      store.applyCloudProfile(mergedCloudUser);
    } else {
      store.resetLocal({ persist: true });
    }
  }

  // 7. 写入新会话并记入本机「曾登录账号」列表
  saveSession(nextSession);
  rememberAccount(nextSession);

  // 8. 刷新页面，走 main.js 标准初始化流程
  location.reload();
  return true;
}

/**
 * 退出当前登录（注册用户与游客通用）
 * 先尝试把未保存改动落盘/上云（失败也不卡住退出），再清会话、清空本地足迹状态并刷新回到登录页。
 * @param {Object} store Store 实例
 * @param {{toast?: Function}} opts
 */
export async function logout(store, opts = {}) {
  const curSession = getSession();

  // 1. 尽量同步未保存改动（失败也继续，绝不卡死退出）
  if (curSession && store) {
    try {
      const synced = await flushSync(store);
      if (!synced && typeof opts.toast === 'function') {
        opts.toast('网络异常，部分最新改动未能同步到云端');
      }
    } catch {
      // 忽略网络异常，继续退出
    }
  }

  // 2. 冻结同步，防止卸载事件重发
  pauseSync(true);

  // 3. 记住当前账号（方便在登录页一键选回；空游客由 getKnownAccounts 自动过滤）
  if (curSession) {
    rememberAccount(resolveSessionWithLatestName(store, curSession));
  }

  // 4. 清空会话与本地 Store 足迹/房间数据（保留主题与音效偏好）
  clearSession();
  if (store) {
    store.resetLocal({ persist: true });
  }

  // 5. 刷新回到登录页
  location.reload();
}

/**
 * 当用户在大厅修改昵称时，同步刷新当前会话与本机记住账号列表中的昵称
 * @param {string} nickname
 */
export function syncSessionNickname(nickname) {
  const clean = typeof nickname === 'string' ? nickname.trim().slice(0, 20) : '';
  if (!clean) return;
  const cur = getSession();
  if (!cur) return;
  const updated = { ...cur, nickname: clean };
  saveSession(updated);
  rememberAccount(updated);
}
