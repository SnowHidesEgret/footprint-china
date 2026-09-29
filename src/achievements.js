/**
 * 点亮中国 · 成就与称号系统
 * 管理八级山河称号体系与十二特色成就的判定与元数据
 */

export const TITLES = [
  { level: 1, name: '初见山海', min: 1, desc: '点亮 1 个省份' },
  { level: 2, name: '行者初程', min: 3, desc: '点亮 3 个省份' },
  { level: 3, name: '走南闯北', min: 6, desc: '点亮 6 个省份' },
  { level: 4, name: '寻味九州', min: 10, desc: '点亮 10 个省份' },
  { level: 5, name: '阅尽千山', min: 16, desc: '点亮 16 个省份' },
  { level: 6, name: '河山胜客', min: 23, desc: '点亮 23 个省份' },
  { level: 7, name: '九州巡抚', min: 30, desc: '点亮 30 个省份' },
  { level: 8, name: '山河大满贯', min: 34, desc: '点亮全部 34 个省级行政区' },
];

export const KNOWN_ACHIEVEMENTS = [
  'grand-slam',
  'frontier',
  'jiangnan',
  'hotpot',
  'yellow-river',
  'yangtze',
  'five-mountains',
  'bay-area',
  'tibet-road',
  'islands',
  'noodles',
  'northland',
];

/** 短名列表（按 prompt 规范） */
const SHORT_PROVINCE_NAMES = [
  '新疆', '西藏', '内蒙古', '黑龙江', '云南', '江苏', '浙江', '上海',
  '安徽', '四川', '重庆', '青海', '甘肃', '宁夏', '陕西', '山西',
  '河南', '山东', '湖南', '湖北', '江西', '贵州', '广东', '香港',
  '澳门', '海南', '台湾', '吉林', '辽宁', '北京', '天津', '河北',
  '广西', '福建',
];

let shortNameToAdcode = null;

/**
 * 从地图数据建立省份短名到 adcode 的映射
 * @param {Array} provinces china.json 的 features 数组
 */
export function initProvinceAdcodes(provinces) {
  shortNameToAdcode = new Map();
  if (!Array.isArray(provinces)) return;

  for (const f of provinces) {
    const name = f.properties && f.properties.name ? String(f.properties.name).trim() : '';
    const adcode = f.properties && f.properties.adcode ? String(f.properties.adcode).trim() : '';
    if (!name || !adcode) continue;

    shortNameToAdcode.set(name, adcode);
    for (const sn of SHORT_PROVINCE_NAMES) {
      if (name.startsWith(sn)) {
        shortNameToAdcode.set(sn, adcode);
      }
    }
  }
}

export function getAdcode(shortName) {
  if (!shortNameToAdcode) return null;
  return shortNameToAdcode.get(shortName) || null;
}

/**
 * 根据点亮省份数推导最高称号
 * @param {number} count 点亮省份数
 * @returns {Object|null} 称号对象或 null
 */
export function getTitleByCount(count) {
  const n = typeof count === 'number' ? count : 0;
  let current = null;
  for (const t of TITLES) {
    if (n >= t.min) {
      current = t;
    }
  }
  return current;
}

export const ACHIEVEMENTS = [
  {
    id: 'grand-slam',
    name: '山河大满贯',
    icon: '🏆',
    conditionText: '34 省全覆盖',
    copy: '九百六十万平方公里的苍茫大地上，每一寸山河都有你的足印。',
    check: (store) => store.litCount() >= 34,
  },
  {
    id: 'frontier',
    name: '边疆征服者',
    icon: '🦅',
    conditionText: '新疆、西藏、内蒙古、黑龙江、云南',
    copy: '从祖国西极到北极村，你将边界线走成了心中的勋章。',
    check: (store, helper) => {
      const list = ['新疆', '西藏', '内蒙古', '黑龙江', '云南'];
      return list.every((sn) => helper.isLit(sn));
    },
  },
  {
    id: 'jiangnan',
    name: '江南烟雨客',
    icon: '🥟',
    conditionText: '江苏、浙江、上海、安徽',
    copy: '沾衣欲湿杏花雨，吹面不寒杨柳风。包邮区被你摸得透透的。',
    check: (store, helper) => {
      const list = ['江苏', '浙江', '上海', '安徽'];
      return list.every((sn) => helper.isLit(sn));
    },
  },
  {
    id: 'hotpot',
    name: '火锅狂热者',
    icon: '🌶️',
    conditionText: '四川、重庆',
    copy: '空气里都是牛油香与藤椒味，巴蜀双子星已被你的胃征服。',
    check: (store, helper) => {
      const list = ['四川', '重庆'];
      return list.every((sn) => helper.isLit(sn));
    },
  },
  {
    id: 'yellow-river',
    name: '大河上下',
    icon: '🌊',
    conditionText: '青海、四川、甘肃、宁夏、内蒙古、陕西、山西、河南、山东',
    copy: '黄河落天走东海，万里写入胸怀间。',
    check: (store, helper) => {
      const list = ['青海', '四川', '甘肃', '宁夏', '内蒙古', '陕西', '山西', '河南', '山东'];
      return list.every((sn) => helper.isLit(sn));
    },
  },
  {
    id: 'yangtze',
    name: '大江奔流',
    icon: '🚢',
    conditionText: '青海、西藏、四川、云南、重庆、湖北、湖南、江西、安徽、江苏、上海',
    copy: '孤帆远影碧空尽，万里长江横渡人。',
    check: (store, helper) => {
      const list = ['青海', '西藏', '四川', '云南', '重庆', '湖北', '湖南', '江西', '安徽', '江苏', '上海'];
      return list.every((sn) => helper.isLit(sn));
    },
  },
  {
    id: 'five-mountains',
    name: '三山五岳',
    icon: '⛰️',
    conditionText: '山东、陕西、湖南、山西、河南',
    copy: '五岳归来不看山，天下名山皆为我友。',
    check: (store, helper) => {
      const list = ['山东', '陕西', '湖南', '山西', '河南'];
      return list.every((sn) => helper.isLit(sn));
    },
  },
  {
    id: 'bay-area',
    name: '特区弄潮儿',
    icon: '🏙️',
    conditionText: '广东、香港、澳门、海南',
    copy: '站在时代的潮头，大湾区与自贸港的阳光晒黑了你的臂弯。',
    check: (store, helper) => {
      const list = ['广东', '香港', '澳门', '海南'];
      return list.every((sn) => helper.isLit(sn));
    },
  },
  {
    id: 'tibet-road',
    name: '进藏天路客',
    icon: '🏔️',
    conditionText: '西藏 +（青海、四川、云南中至少两个）',
    copy: '无论是川藏线、青藏线还是滇藏线，雪山洗涤了你的灵魂。',
    check: (store, helper) => {
      if (!helper.isLit('西藏')) return false;
      const count = ['青海', '四川', '云南'].filter((sn) => helper.isLit(sn)).length;
      return count >= 2;
    },
  },
  {
    id: 'islands',
    name: '海岛追风人',
    icon: '🥥',
    conditionText: '海南、台湾',
    copy: '双岛碧浪，踏浪听涛，祖国两大宝岛皆留下你的笑语。',
    check: (store, helper) => {
      return helper.isLit('海南') && helper.isLit('台湾');
    },
  },
  {
    id: 'noodles',
    name: '面食大宗师',
    icon: '🍜',
    conditionText: '陕西、山西、河南、山东',
    copy: '油泼面、刀削面、烩面、拉面，碳水的快乐你最懂。',
    check: (store, helper) => {
      const list = ['陕西', '山西', '河南', '山东'];
      return list.every((sn) => helper.isLit(sn));
    },
  },
  {
    id: 'northland',
    name: '北国风光',
    icon: '❄️',
    conditionText: '黑龙江、吉林、辽宁三省所有地级市全点亮',
    copy: '千里冰封，万里雪飘，黑土地上的每一个角落都留下了你的体温。',
    isCityLevel: true,
    check: (store, helper) => {
      // 城市数据懒加载：判定 northland 时，若三省中任一城市数据尚未加载到内存，则本轮跳过该成就判定（不误判、不解锁），等城市数据加载完成后再判定。
      // 黑龙江/吉林/辽宁的 adcode 前缀：23/22/21（从 maps/cities 文件名取前两位）。
      // 分母用 maps/cities/230000_full.json、220000_full.json、210000_full.json 各自 features 数量之和。
      const neCodes = ['210000', '220000', '230000'];
      for (const code of neCodes) {
        if (!helper.isCityGeoLoaded(code)) {
          return false;
        }
      }
      for (const code of neCodes) {
        const cities = helper.getCityGeo(code);
        if (!cities || !Array.isArray(cities) || cities.length === 0) {
          return false;
        }
        for (const city of cities) {
          const cadcode = String(city.properties && city.properties.adcode);
          if (!cadcode || !store.isCityLit(cadcode)) {
            return false;
          }
        }
      }
      return true;
    },
  },
];

/**
 * 遍历检查所有成就，解锁达标且尚未解锁的成就并返回
 * @param {Object} store 单例 store
 * @param {Object} helper { isLit, isCityGeoLoaded, getCityGeo, getAdcode }
 * @returns {Array} 本轮新解锁的成就对象数组
 */
export function checkAchievements(store, helper) {
  const newlyUnlocked = [];
  for (const ach of ACHIEVEMENTS) {
    if (store.isAchievementUnlocked(ach.id)) {
      continue;
    }
    const passed = ach.check(store, helper);
    if (passed) {
      const ok = store.unlockAchievement(ach.id);
      if (ok) {
        newlyUnlocked.push(ach);
      }
    }
  }
  return newlyUnlocked;
}
