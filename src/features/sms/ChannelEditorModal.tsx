/**
 * 渠道编辑器：**手机号与邮箱同一个组件、同一套样式**。
 *
 * 版面（按类别自动编号；手机号比邮箱多一段「选择平台」，所以编号按实际段数走）：
 *   ① 渠道信息 —— 名称 + 类别
 *   ② 选择平台 —— 内置平台 / 自定义（仅手机号）
 *   ③ 接入方式 —— 手机号多选（勾几种就配几种），邮箱二选一
 *   ④ 连接信息 —— 每种接入方式一个块，块内**自带该方式的验证动作**
 *
 * 为什么手机号的接入方式是**多选**而不是互斥 Tab：基座把接入方式当成**集合**（`natures`），
 * 渠道池表「连接方式」那一列显示的就是这个集合。互斥 Tab 表达不了「API 接入 +
 * 网页登录同时开」，会跟自己的表自相矛盾。
 *
 * 为什么邮箱是**二选一**：同一个信箱只有一种凭据（授权码，或者 OAuth2 的刷新令牌）。
 * 两种并存是一条基座会拒收的记录，也是一个界面回答不了的问题。
 *
 * 为什么手机号的凭据填在「连接信息」里、却不进渠道记录：手机号这一类**只有一份**
 * 平台凭据（存在密钥库，条目名由基座配置持有），渠道记录里的连接只**指名**它。
 * 面板既不接触凭据的值，也不接触条目名 —— 后者由基座在保存渠道时自己盖章
 * （见基座 `supply_channels.go`）。
 *
 * 保存契约：
 * - 必填只有两个：名称、至少一种接入方式；
 * - 凭据**留空 = 保留已存的值**（基座把空字段当保留，历史覆盖事故见 `docs/ops/07` §11.22）；
 *   一旦填了某一种方式的两个框中的任意一个，两个都必须填齐 —— 不做「半条凭据」的静默合并；
 * - 保存成功后**自动收窗**：结果已经落在渠道表里，再让人点一次「关闭」只是多一步。
 *
 * ⚠️ 面向使用者，不暴露后端字段名；主密码只从 SecretGate 的门取（内存中），
 * 本组件不自行收集密码。锁定态下保存会被后端 401 拒绝，此处如实提示。
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { IconAlertTriangle, IconCheckCircle2, IconRefreshCw } from '@/components/ui/icons';
import { emailApi } from '@/services/api/email';
import {
  smsApi,
  type CredentialWriteResult,
  type SmsApiCredentialInput,
} from '@/services/api/sms';
import { supplyApi } from '@/services/api/supply';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import {
  channelDraftFromChannel,
  channelDraftToInput,
  emptyChannelDraft,
  emptyConnection,
  platformNatures,
  type ChannelDraft,
  type ConnectionDraft,
} from './channelDraft';
import {
  CATEGORY_LABEL,
  EMAIL_CATEGORY_OPTIONS,
  EMAIL_DEFAULT_NATURE,
  EMAIL_NATURES,
  NATURE_LABEL,
  PHONE_CATEGORY_OPTIONS,
  SMS_PLATFORMS,
  isCatchAllCategory,
  resolvePlatformId,
  usesRefreshToken,
} from './smsMapping';
import type {
  PhoneCredentialState,
  SmsPlatform,
  SupplyChannel,
  SupplyKind,
  SupplyNature,
  SupplyNatureOption,
} from './types';
import styles from './ChannelEditorModal.module.scss';

/** 段号字形。段数随类别变化（邮箱没有「选择平台」那一段），所以编号是算出来的。 */
const STEP_MARKS = ['①', '②', '③', '④'];

/**
 * 「测试连接」的结果。
 *
 * 只回答一件事：**连得上还是连不上**。余额与渠道数不在这里 —— 它们属于渠道池，
 * 而这个按钮的责任是验证凭据。
 */
type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'fail'; message: string }
  | { kind: 'unavailable'; message: string };

/** 「登录并获取网页会话」的结果：只回答登录成没成。 */
type WebLoginState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok' }
  | { kind: 'fail'; message: string };

export interface ChannelEditorModalProps {
  open: boolean;
  /** 正在编辑哪一类身份：决定可选的接入方式，以及要不要平台那一段。 */
  kind: SupplyKind;
  /** 正在编辑的渠道；`null` = 新增。 */
  channel: SupplyChannel | null;
  /** 基座声明的「哪种接入方式能服务哪类身份」，页面不自己维护一份。 */
  natures: SupplyNatureOption[];
  /** 手机号类别的平台凭据现状；邮箱类别传 `null`。 */
  credential: PhoneCredentialState | null;
  onClose: () => void;
  /** 保存成功后回调（父组件据此重新拉一次表与状态）。 */
  onSaved: () => void;
}

export function ChannelEditorModal({
  open,
  kind,
  channel,
  natures,
  credential,
  onClose,
  onSaved,
}: ChannelEditorModalProps) {
  const { t } = useTranslation();
  const passphrase = useSecretGateStore((state) => state.passphrase);
  const gatePhase = useSecretGateStore((state) => state.phase);
  const categoryId = useId();

  const [draft, setDraft] = useState<ChannelDraft>(emptyChannelDraft);
  /**
   * 使用者**显式**选的平台；`null` = 跟随已存凭据所属的平台。
   *
   * 手机号这一类只有**一份**平台凭据，渠道记录只**指名**它 —— 所以「平台」不是自由
   * 选项，默认就该是已存凭据所属的那个。若一律默认内置平台，编辑一个配在「自定义」
   * 上的渠道时，名称标签、地址框与脱敏提示会**三处同时说错**。
   */
  const [platformChoice, setPlatformChoice] = useState<string | null>(null);
  // 手机号平台凭据。内置平台的地址由基座固定，界面只读展示。
  const [apiUser, setApiUser] = useState('');
  const [apiPass, setApiPass] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [webUser, setWebUser] = useState('');
  const [webPass, setWebPass] = useState('');
  /**
   * 邮箱的凭据：授权码，或者 OAuth2 的刷新令牌（看这一条渠道选的是哪种方式）。
   *
   * 它**不是**渠道记录的一部分：渠道里存的是密钥库条目名，这里填的值直接写进密钥库，
   * 保存后清空、不回显 —— 明文凭据不进渠道文档。
   */
  const [mailCredential, setMailCredential] = useState('');
  const [apiTest, setApiTest] = useState<TestState>({ kind: 'idle' });
  const [webLogin, setWebLogin] = useState<WebLoginState>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 名称是否被使用者改过。
   *
   * 手机号的名称**默认就是平台名**：平台名本来就是这条渠道最自然的叫法，让使用者再抄
   * 一遍是把联动性做断。改过之后才不再跟随，绝不覆盖已经写下的命名。
   */
  const [labelEdited, setLabelEdited] = useState(false);
  /**
   * 类别与接入方式是否被使用者改过 —— 与名称同一套规则。
   *
   * 平台是内置的，它的类别（第三方服务）与支持的接入方式（API + 网页）就不是选择题。
   * 使用者一旦自己动过，就以他的选择为准。
   */
  const [categoryEdited, setCategoryEdited] = useState(false);
  const [naturesEdited, setNaturesEdited] = useState(false);

  /** 选中的平台：使用者显式选过就用它，否则跟随已存凭据所属的平台。 */
  const platformId = useMemo(
    () => resolvePlatformId(platformChoice, credential?.provider),
    [platformChoice, credential]
  );

  const platform = useMemo(
    () => SMS_PLATFORMS.find((item) => item.id === platformId) ?? SMS_PLATFORMS[0],
    [platformId]
  );
  /** 内置平台的地址由基座固定，不采集。 */
  const endpointLocked = Boolean(platform.defaultEndpoint);
  /**
   * 已存凭据属于**配置里那个平台**。只有当前选的正是它时，脱敏提示才成立 ——
   * 选了「自定义」却还显示内置平台的账号，就是在拿别人的凭据当提示。
   */
  const credentialBelongsHere = credential?.provider === platformId;

  /**
   * 这是「编辑已存渠道」还是「新建一条」。
   *
   * 凭据框显示什么由它决定：编辑时显示**已存账号的脱敏提示**（并说明留空即保留），
   * 新建时显示**引导文案** —— 一个掩码占位符摆在新建表单里，看起来就像「已经有人
   * 填好了」，而这条渠道此刻还没有任何凭据。两者混用会让人分不清「这是值还是提示」。
   */
  const isEditing = channel !== null;

  const block = draft[kind];
  /**
   * 这一类能用的接入方式。
   *
   * 邮箱两种，都是连上那个信箱按收件地址找信，区别只在拿什么证明身份（授权码 /
   * OAuth2）。基座虽然还认得邮箱的 `api`，但没有实现，勾上只会得到一条永远连不上的
   * 渠道。
   */
  const allowed = useMemo(
    () =>
      natures
        .filter((item) => item.kinds.includes(kind))
        .filter((item) => kind !== 'email' || EMAIL_NATURES.includes(item.nature)),
    [natures, kind]
  );
  /**
   * 这个平台**已知的事实**；「自定义」什么都不已知（它连协议都不确定）。
   *
   * 只对手机号成立：邮箱这一类没有平台可挑。
   */
  const platformFacts = kind === 'phone' && platform.preset ? platform : null;

  /** 平台名可以直接当渠道名；「自定义」不是一个能当名字用的词，得使用者自己起。 */
  const platformLabel = (item: SmsPlatform) => (item.preset ? t(item.nameKey) : '');
  /** 名称的当前值：没被改过就跟随平台（邮箱没有平台，必须自己填）。 */
  const label = kind === 'phone' && !labelEdited ? platformLabel(platform) : draft.label;

  /** 类别的当前值：内置平台的类别是已知事实，没被改过就跟随它。 */
  const category =
    !categoryEdited && platformFacts?.defaultCategory
      ? platformFacts.defaultCategory
      : draft.category;

  /**
   * 手机号的类别不是选择题：接码平台的号都是别人的服务，现在只有「第三方服务」这一种。
   *
   * 一条渠道可以同时承载手机号与邮箱，类别是**渠道级**的。所以这里只补空值，不覆盖已存
   * 的值 —— 否则从手机号那一栏编辑一条自建域的渠道，会把它的域名类别顺手改掉。
   */
  const phoneCategory = category.trim() === '' ? PHONE_CATEGORY_OPTIONS[0] : category;

  /**
   * 邮箱能选的类别。
   *
   * 三种：别人的邮箱服务、自己建的域（catch-all）、自己的信箱。已存的值即使不在选项里
   * 也要留着显示 —— 否则打开一条旧渠道时类别框是空的，看起来像「没设」，一保存就把
   * 人家的类别改掉。手机号不画这个框（类别是固定事实），所以只有邮箱用得上这份列表。
   */
  const categoryOptions = useMemo(() => {
    const base: readonly string[] = EMAIL_CATEGORY_OPTIONS;
    if (category.trim() === '' || base.includes(category)) return [...base];
    return [...base, category];
  }, [category]);

  /**
   * 接入方式的当前值：内置平台支持哪几种就勾哪几种（与后端允许的方式取交集）。
   *
   * 勾选框、连接块、必填判据、提交**都读这一个集合** —— 否则界面勾着两种、提交却只写
   * 一种，或反过来。
   *
   * 邮箱是**二选一**：同一个信箱只有一种凭据，两种并存是基座会拒收的矛盾记录。已存的
   * 那一种优先，没存过就是授权码（绝大多数邮箱都走它）。
   */
  const chosenNatures = useMemo(() => {
    if (kind === 'email') {
      const stored = EMAIL_NATURES.find((nature) => block.natures.has(nature));
      return new Set<SupplyNature>([stored ?? EMAIL_DEFAULT_NATURE]);
    }
    const defaults = platformFacts?.defaultNatures;
    if (!defaults || naturesEdited) return block.natures;
    return platformNatures(defaults, allowed.map((item) => item.nature));
  }, [kind, platformFacts, naturesEdited, block.natures, allowed]);

  // 每次打开（或换了一条渠道）都把表单重置成「只显示已存状态」。
  useEffect(() => {
    if (!open) return;
    const restored = channel ? channelDraftFromChannel(channel) : emptyChannelDraft();
    setDraft(restored);
    /**
     * 已存的值就是使用者的选择，一律不覆盖；**空的**才跟着平台补上 ——
     * 名字、类别、接入方式三处同一条规则（旧数据里空着的，编辑器顺手补全）。
     */
    setLabelEdited(channel ? channel.label.trim() !== '' : false);
    setCategoryEdited(channel ? channel.category.trim() !== '' : false);
    setNaturesEdited(channel ? restored[kind].natures.size > 0 : false);
    setPlatformChoice(null);
    setApiUser('');
    setApiPass('');
    setEndpoint('');
    setWebUser('');
    setWebPass('');
    setMailCredential('');
    setApiTest({ kind: 'idle' });
    setWebLogin({ kind: 'idle' });
    setSaving(false);
    setAttempted(false);
    setError(null);
  }, [open, channel, kind]);

  const selected = allowed.filter((item) => chosenNatures.has(item.nature));

  const apiSelected = kind === 'phone' && chosenNatures.has('api');
  const webSelected = kind === 'phone' && chosenNatures.has('web');
  const apiFilled = apiUser.trim() !== '' || apiPass.trim() !== '';
  const apiComplete = apiUser.trim() !== '' && apiPass.trim() !== '';
  const webFilled = webUser.trim() !== '' || webPass.trim() !== '';
  const webComplete = webUser.trim() !== '' && webPass.trim() !== '';

  const labelMissing = attempted && label.trim() === '';
  const categoryMissing = attempted && kind === 'email' && category.trim() === '';
  const naturesMissing = attempted && chosenNatures.size === 0;
  const apiPairBroken = attempted && apiSelected && apiFilled && !apiComplete;
  const webPairBroken = attempted && webSelected && webFilled && !webComplete;
  /**
   * 这个邮箱替一整个域收信吗？
   *
   * 只由**类别**回答（见 `isCatchAllCategory`）：这是能力的事实，不是接入方式。
   * 所以「域名」这一格是类别的结果，不是一个可以独立选的开关。
   */
  const catchAll = kind === 'email' && isCatchAllCategory(category);
  /** 邮箱选中的那一种接入方式；手机号没有「唯一一种」这回事。 */
  const mailNature: SupplyNature | null =
    kind === 'email' ? ([...chosenNatures][0] ?? EMAIL_DEFAULT_NATURE) : null;
  /** 邮箱这一种方式自己的连接信息 —— 域名、应用 ID 都挂在它下面。 */
  const mailConnection = mailNature ? (block.connections[mailNature] ?? emptyConnection()) : null;
  const domainMissing = attempted && catchAll && (mailConnection?.domain ?? '').trim() === '';
  /** 用刷新令牌的两种方式少了应用 ID 就换不到令牌，保存下去就是一条读不到信的渠道。 */
  const clientIdMissing =
    attempted && usesRefreshToken(mailNature) && (mailConnection?.clientId ?? '').trim() === '';

  /** 上一次的测试结果与错误，都随输入变化失效。 */
  const resetFeedback = () => {
    setApiTest({ kind: 'idle' });
    setWebLogin({ kind: 'idle' });
    setError(null);
  };

  const updateBlock = (updater: (current: typeof block) => typeof block) => {
    setDraft((current) => ({ ...current, [kind]: updater(current[kind]) }));
  };

  const toggleNature = (nature: SupplyNature) => {
    // 从**界面上显示的那个集合**起算：勾选框画的是 `chosenNatures`，若从草稿里的空集合
    // 起算，取消勾选反而会把它加上去。
    const next = new Set(chosenNatures);
    if (next.has(nature)) next.delete(nature);
    else next.add(nature);
    setNaturesEdited(true);
    updateBlock((current) => {
      const connections = { ...current.connections };
      if (!connections[nature]) connections[nature] = emptyConnection();
      return { ...current, natures: next, connections };
    });
    setAttempted(false);
    resetFeedback();
  };

  /**
   * 邮箱换一种接入方式：**替换**，不是叠加。
   *
   * 同一个信箱只有一种凭据。顺带清掉已经填进框里的值：那是上一种方式的凭据，带过去
   * 会存进另一种方式的条目里 —— 读不到信，而报错只会说「登录被拒」。
   */
  const chooseEmailNature = (nature: SupplyNature) => {
    setNaturesEdited(true);
    updateBlock((current) => {
      const connections = { ...current.connections };
      if (!connections[nature]) connections[nature] = emptyConnection();
      return { ...current, natures: new Set([nature]), connections };
    });
    setMailCredential('');
    setAttempted(false);
    resetFeedback();
  };

  const updateConnection = (nature: SupplyNature, field: keyof ConnectionDraft, value: string) => {
    updateBlock((current) => ({
      ...current,
      connections: {
        ...current.connections,
        [nature]: {
          ...(current.connections[nature] ?? emptyConnection()),
          [field]: value,
          // 改了邮箱账号，旧条目名就指向另一个邮箱了：清掉它，让基座按新账号重新
          // 派生 —— 否则渠道指向的条目和刚写进去的授权码会是两个名字。
          ...(kind === 'email' && field === 'account' ? { secret: '' } : {}),
        },
      },
    }));
    resetFeedback();
  };

  /** 把一次凭据写入的结果落到界面上；失败返回 false，调用方据此中止保存。 */
  const applyCredentialResult = (result: CredentialWriteResult): boolean => {
    if (result.ok) return true;
    if (result.reason === 'wrong-passphrase') setError(t('sms_service.config_err_passphrase'));
    else if (result.reason === 'locked') setError(t('sms_service.config_err_locked'));
    else setError(result.message || t('sms_service.config_err_generic'));
    return false;
  };

  /**
   * 保存：先落凭据，再落渠道记录。
   *
   * 顺序是有意的 —— 凭据才是让这条渠道真的能用的东西，而写凭据要过主密码那道门；
   * 门没过就先去建一条记录，只会留下一条谁也连不上的空壳。
   */
  const handleSave = async () => {
    setAttempted(true);
    if (label.trim() === '' || chosenNatures.size === 0) return;
    // 类别没说清是哪种邮箱：三种情形要的东西不同（域名、或者不），不选就是猜。
    if (kind === 'email' && category.trim() === '') return;
    if (apiPairBroken || webPairBroken) return;
    // 类别说这是自己的域，却没有域名：基座会拒收，而界面上只有这一格是空的。
    if (catchAll && (mailConnection?.domain ?? '').trim() === '') return;
    // 用刷新令牌的方式没有应用 ID 就换不到令牌：基座会拒收，界面上也只有这一格是空的。
    if (usesRefreshToken(mailNature) && (mailConnection?.clientId ?? '').trim() === '') return;
    setSaving(true);
    setError(null);
    try {
      if (kind === 'phone') {
        if (apiSelected && apiFilled) {
          const input: SmsApiCredentialInput = {
            api_user: apiUser.trim(),
            api_pass: apiPass.trim(),
          };
          // 自定义平台：填了地址才带上；空串在后端是「保留旧值」，会把自定义地址静默吃掉。
          if (!endpointLocked && endpoint.trim() !== '') input.endpoint = endpoint.trim();
          if (!applyCredentialResult(await smsApi.saveApiCredential(input, passphrase))) return;
        }
        if (webSelected && webFilled) {
          const result = await smsApi.saveWebCredential(
            { username: webUser.trim(), password: webPass.trim() },
            passphrase
          );
          if (!applyCredentialResult(result)) return;
        }
      }
      if (kind === 'email' && mailNature && mailCredential.trim() !== '') {
        // 条目名由邮箱账号和接入方式共同决定，界面不问：凭据属于那个邮箱，不属于渠道。
        // 已存的条目名照旧带上，老渠道指向的条目不会因此被孤立。
        const result = await emailApi.saveCredential(
          {
            account: (mailConnection?.account ?? '').trim(),
            name: (mailConnection?.secret ?? '').trim(),
            secret: mailCredential.trim(),
            nature: mailNature === 'graph' ? 'graph' : mailNature === 'oauth2' ? 'oauth2' : 'imap',
          },
          passphrase
        );
        if (!result.ok) {
          if (result.reason === 'wrong-passphrase') setError(t('sms_service.config_err_passphrase'));
          else if (result.reason === 'locked') setError(t('sms_service.config_err_locked'));
          else setError(result.message || t('sms_service.config_err_generic'));
          return;
        }
        // 值已经进密钥库，界面上不再留着它。
        setMailCredential('');
      }
      /**
       * 提交的是**界面上显示的那一份**：名称、类别、接入方式都可能来自平台（使用者
       * 没改过）。只替换正在编辑的这个类别块，另一块原样带回 —— 基座是整条渠道替换。
       */
      const submitted: ChannelDraft = {
        ...draft,
        label,
        // 手机号的类别是固定事实（见 `phoneCategory`），提交的就是界面上写着的那一个。
        category: kind === 'phone' ? phoneCategory : category,
        phone: kind === 'phone' ? { ...draft.phone, natures: chosenNatures } : draft.phone,
        email: kind === 'email' ? { ...draft.email, natures: chosenNatures } : draft.email,
      };
      const result = await supplyApi.saveChannel(channelDraftToInput(submitted));
      if (!result.ok) {
        setError(result.message || t('sms_service.source_err_generic'));
        return;
      }
      setAttempted(false);
      // 保存成功即收窗：结果已经在渠道表里了，再让使用者点一次「关闭」只是多一步。
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  /**
   * 真实测试连接：调基座状态路由，按其三态判定。验的是**已保存**的凭据。
   *
   * `balance_cny` 只当作「凭据有效」的判据，不往界面上搬：这个按钮的责任是回答
   * 「连得上吗」，余额属于渠道池那一边。
   */
  const handleTest = async () => {
    setApiTest({ kind: 'testing' });
    try {
      const status = await smsApi.getStatus();
      if (typeof status.balance_cny === 'number') {
        setApiTest({ kind: 'ok' });
      } else if (status.status === 'unavailable') {
        // 凭据未就绪（锁着 / 没存）—— 不能当成「连接失败」。
        setApiTest({
          kind: 'unavailable',
          message: status.error ?? t('sms_service.config_test_need_creds'),
        });
      } else {
        setApiTest({
          kind: 'fail',
          message: status.balance_error ?? t('sms_service.config_test_fail'),
        });
      }
    } catch (caught) {
      setApiTest({
        kind: 'fail',
        message: (caught as { message?: string })?.message ?? t('sms_service.config_test_fail'),
      });
    }
  };

  /**
   * 获取网页会话：基座取验证码 → 解点选顺序 → 提交登录 → 存会话。
   * 登录失败不落库；账号/密码留空则复用已存值。
   */
  const handleWebLogin = async () => {
    setWebLogin({ kind: 'busy' });
    setError(null);
    try {
      const result = await smsApi.webLogin(
        { username: webUser.trim(), password: webPass.trim() },
        passphrase
      );
      if (result.ok) setWebLogin({ kind: 'ok' });
      else setWebLogin({ kind: 'fail', message: result.message });
    } finally {
      // 无论成败都刷新一次，父组件能反映最新凭据状态。
      onSaved();
    }
  };

  /** 一种接入方式的连接信息块。手机号的两种方式各自带一个验证动作。 */
  const connectionBlock = (nature: SupplyNature): ReactNode => {
    const connection = block.connections[nature] ?? emptyConnection();
    const keepBlank = t('sms_service.config_keep_blank');
    /**
     * 脱敏的已存账号**只在编辑时**出现：新建渠道没有「已存的值」可保留，
     * 摆一个掩码占位符只会让人以为已经填好了。
     */
    const apiHint = isEditing && credentialBelongsHere ? (credential?.apiUserHint ?? '') : '';
    const webHint = isEditing && credentialBelongsHere ? (credential?.webUserHint ?? '') : '';
    /**
     * 「留空则保留已存的值」说的是**有没有已存凭据**，不是「有没有脱敏字符串」。
     *
     * 两者不等价：凭据在、但账号字段为空时脱敏串是空的。密钥库锁着时基座报不出
     * 条目名、也报「不存在」—— 那种情况下我们无从断言「已存」，所以照样不说。
     * 判据取「确实知道它存在」，不用「碰巧有东西可显示」。
     */
    const apiStored = isEditing && credentialBelongsHere && credential?.apiPresent === true;
    const webStored = isEditing && credentialBelongsHere && credential?.webPresent === true;
    return (
      <div className={styles.block} key={nature}>
        {/* 邮箱只有一个块，上面的「接入方式」已经说过这是收件服务（IMAP）；
            这里再写一遍同样的标题就是同一句话说两次。手机号有两个块，标题有用。 */}
        {kind === 'phone' && (
          <div className={styles.blockTitle}>{t(NATURE_LABEL[nature])}</div>
        )}
        {/* 手机号的两种方式用不同的凭据，说清楚「这两个框填哪个账号」比让使用者猜好。 */}
        {kind === 'phone' && (
          <div className={styles.blockLead}>
            {nature === 'api'
              ? t('sms_service.config_api_lead')
              : t('sms_service.config_web_lead')}
          </div>
        )}

        {kind === 'email' && (
          <Input
            label={t('sms_service.source_field_imap_host')}
            placeholder="imap.qq.com:993"
            hint={t('sms_service.source_hint_imap_host')}
            value={connection.endpoint}
            onChange={(event) => updateConnection(nature, 'endpoint', event.target.value)}
          />
        )}

        {kind === 'phone' && nature === 'api' ? (
          <>
            {endpointLocked ? (
              <div className={styles.staticField}>
                <span className={styles.staticLabel}>
                  {t('sms_service.config_field_endpoint')}
                </span>
                <span className={styles.staticValue}>{platform.defaultEndpoint}</span>
                <span className={styles.staticNote}>
                  {t('sms_service.config_endpoint_builtin')}
                </span>
              </div>
            ) : (
              <Input
                label={t('sms_service.config_field_endpoint')}
                placeholder="https://api.example.com"
                hint={isEditing ? t('sms_service.config_field_endpoint_opt') : undefined}
                value={endpoint}
                onChange={(event) => {
                  setEndpoint(event.target.value);
                  resetFeedback();
                }}
              />
            )}
            <div className={styles.fieldGrid}>
              <Input
                label={t('sms_service.config_field_api_account')}
                placeholder={apiHint || t('sms_service.config_ph_api_account')}
                error={apiPairBroken && apiUser.trim() === '' ? t('sms_service.config_required') : undefined}
                value={apiUser}
                onChange={(event) => {
                  setApiUser(event.target.value);
                  resetFeedback();
                }}
              />
              <Input
                label={t('sms_service.config_field_api_secret')}
                type="password"
                placeholder="••••••••"
                error={apiPairBroken && apiPass.trim() === '' ? t('sms_service.config_required') : undefined}
                value={apiPass}
                onChange={(event) => {
                  setApiPass(event.target.value);
                  resetFeedback();
                }}
              />
            </div>
            {/* 一句话说清这一对框留空意味着什么；写在框下面重复四遍只是噪音。 */}
            {apiStored && <div className={styles.fieldNote}>{keepBlank}</div>}
            <div className={styles.blockActions}>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleTest}
                disabled={apiTest.kind === 'testing' || gatePhase === 'locked'}
              >
                <IconRefreshCw size={14} />
                {t('sms_service.config_test')}
              </Button>
              {apiTest.kind === 'ok' && (
                <span className={`${styles.result} ${styles.resultOk}`}>
                  <IconCheckCircle2 size={15} />
                  {t('sms_service.config_test_ok')}
                </span>
              )}
              {apiTest.kind === 'fail' && (
                <span className={`${styles.result} ${styles.resultFail}`}>
                  <IconAlertTriangle size={15} />
                  {apiTest.message}
                </span>
              )}
              {apiTest.kind === 'unavailable' && (
                <span className={`${styles.result} ${styles.resultWarn}`}>
                  <IconAlertTriangle size={15} />
                  {apiTest.message}
                </span>
              )}
              {apiTest.kind !== 'testing' && (
                <span className={styles.resultNote}>{t('sms_service.config_test_note')}</span>
              )}
            </div>
          </>
        ) : null}

        {kind === 'phone' && nature === 'web' ? (
          <>
            <div className={styles.fieldGrid}>
              <Input
                label={t('sms_service.config_field_web_user')}
                placeholder={webHint || t('sms_service.config_ph_web_user')}
                error={webPairBroken && webUser.trim() === '' ? t('sms_service.config_required') : undefined}
                value={webUser}
                onChange={(event) => {
                  setWebUser(event.target.value);
                  resetFeedback();
                }}
              />
              <Input
                label={t('sms_service.config_field_web_pass')}
                type="password"
                placeholder="••••••••"
                error={webPairBroken && webPass.trim() === '' ? t('sms_service.config_required') : undefined}
                value={webPass}
                onChange={(event) => {
                  setWebPass(event.target.value);
                  resetFeedback();
                }}
              />
            </div>
            {webStored && <div className={styles.fieldNote}>{keepBlank}</div>}
            <div className={styles.blockActions}>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleWebLogin}
                disabled={webLogin.kind === 'busy' || gatePhase === 'locked'}
              >
                <IconRefreshCw size={14} />
                {webLogin.kind === 'busy'
                  ? t('sms_service.config_web_login_busy')
                  : t('sms_service.config_web_login')}
              </Button>
              {webLogin.kind === 'ok' && (
                <span className={`${styles.result} ${styles.resultOk}`}>
                  <IconCheckCircle2 size={15} />
                  {t('sms_service.config_web_login_ok')}
                </span>
              )}
              {webLogin.kind === 'fail' && (
                <span className={`${styles.result} ${styles.resultFail}`}>
                  <IconAlertTriangle size={15} />
                  {webLogin.message}
                </span>
              )}
              {webLogin.kind !== 'busy' && (
                <span className={styles.resultNote}>
                  {t('sms_service.config_web_login_note')}
                </span>
              )}
            </div>
          </>
        ) : null}

        {kind === 'email' ? (
          <>
            <Input
              label={t('sms_service.source_field_mail_account')}
              placeholder={t('sms_service.source_ph_mail_account')}
              value={connection.account}
              onChange={(event) => updateConnection(nature, 'account', event.target.value)}
            />
            {/* 域名是**类别的结果**，不是第二个开关：类别说这是能全收的自建域，这一格才出现。
                两个地方各问一遍「是不是自建域」，答不一样时没人说得清该听谁的。 */}
            {catchAll && (
              <>
                <div className={styles.blockLead}>
                  {t('sms_service.email_lead_self_hosted')}
                </div>
                <Input
                  label={t('sms_service.field_domain')}
                  placeholder={t('sms_service.source_ph_domain')}
                  hint={t('sms_service.source_hint_domain')}
                  error={domainMissing ? t('sms_service.config_required') : undefined}
                  value={connection.domain}
                  onChange={(event) => updateConnection(nature, 'domain', event.target.value)}
                />
              </>
            )}
            {/* 用刷新令牌的两种方式都要两样东西：哪个应用在问（应用 ID，随渠道记录
                保存、可回读），以及那个应用的刷新令牌（只进密钥库）。 */}
            {usesRefreshToken(nature) && (
              <Input
                label={t('sms_service.field_mail_client_id')}
                placeholder="00000000-0000-0000-0000-000000000000"
                hint={t('sms_service.field_mail_client_id_hint')}
                error={clientIdMissing ? t('sms_service.config_required') : undefined}
                value={connection.clientId}
                onChange={(event) => updateConnection(nature, 'clientId', event.target.value)}
              />
            )}
            {/* 凭据只写进密钥库、保存后清空。条目名由邮箱账号和接入方式决定，界面不问：
                这个值属于那个邮箱，不属于这条渠道。 */}
            <Input
              label={
                usesRefreshToken(nature)
                  ? t('sms_service.field_mail_refresh_token')
                  : t('sms_service.field_mail_auth_code')
              }
              type="password"
              autoComplete="off"
              hint={
                gatePhase === 'locked'
                  ? t('sms_service.config_gate_locked_hint')
                  : usesRefreshToken(nature)
                    ? t('sms_service.field_mail_refresh_token_hint')
                    : t('sms_service.field_mail_auth_code_hint')
              }
              value={mailCredential}
              onChange={(event) => {
                setMailCredential(event.target.value);
                resetFeedback();
              }}
            />
          </>
        ) : null}
      </div>
    );
  };

  const sections: { key: string; label: string; body: ReactNode }[] = [
    {
      key: 'identity',
      label: t('sms_service.config_step_identity'),
      body: (
        <>
          <div className={styles.fieldGrid}>
            <Input
              label={
                kind === 'phone' && !endpointLocked
                  ? t('sms_service.config_field_custom_name')
                  : t('sms_service.source_field_name')
              }
              placeholder={t('sms_service.source_ph_name')}
              error={labelMissing ? t('sms_service.source_err_name') : undefined}
              value={label}
              onChange={(event) => {
                setLabelEdited(true);
                setDraft((current) => ({ ...current, label: event.target.value }));
                setAttempted(false);
                resetFeedback();
              }}
            />
            {kind === 'email' ? (
              <div className={styles.selectField}>
                <label className={styles.fieldLabel} htmlFor={categoryId}>
                  {t('sms_service.field_category')}
                </label>
                <Select
                  id={categoryId}
                  value={category}
                  options={categoryOptions.map((value) => ({
                    value,
                    label: t(CATEGORY_LABEL[value]),
                  }))}
                  placeholder={t('sms_service.source_ph_category')}
                  onChange={(next) => {
                    setCategoryEdited(true);
                    setDraft((current) => {
                      const updated: ChannelDraft = { ...current, category: next };
                      /**
                       * 类别不再是「能全收的自建域」时，域名这个事实就不成立了。
                       *
                       * 留着它不会让渠道更能收信：基座会拒收这条自相矛盾的记录，而界面上
                       * 那个框已经藏起来了 —— 人会看到一个查不到原因的失败。所以改类别
                       * 的同时把它清掉。
                       */
                      const selected = mailNature ? updated.email.connections[mailNature] : null;
                      if (!isCatchAllCategory(next) && mailNature && selected) {
                        updated.email = {
                          ...updated.email,
                          connections: {
                            ...updated.email.connections,
                            [mailNature]: { ...selected, domain: '' },
                          },
                        };
                      }
                      return updated;
                    });
                    resetFeedback();
                  }}
                  ariaLabel={t('sms_service.field_category')}
                  ariaInvalid={categoryMissing ? true : undefined}
                  fullWidth
                />
                {categoryMissing && (
                  <span className={styles.fieldNoteWarn}>
                    {t('sms_service.source_err_category')}
                  </span>
                )}
              </div>
            ) : (
              /* 手机号的类别是已知事实，不是选择题：画成下拉框等于给一个点不动的东西。
                 与内置平台地址同一套「只读事实」的写法。 */
              <div className={styles.staticField}>
                <span className={styles.staticLabel}>{t('sms_service.field_category')}</span>
                <span className={styles.staticValue}>{t(CATEGORY_LABEL[phoneCategory])}</span>
                <span className={styles.staticNote}>{t('sms_service.category_phone_note')}</span>
              </div>
            )}
          </div>
        </>
      ),
    },
  ];

  if (kind === 'phone') {
    sections.push({
      key: 'platform',
      label: t('sms_service.config_step_platform'),
      body: (
        <div className={styles.platformList}>
          {SMS_PLATFORMS.map((item) => {
            const active = item.id === platformId;
            return (
              <button
                key={item.id}
                type="button"
                className={`${styles.platformCard} ${active ? styles.platformCardActive : ''}`}
                aria-pressed={active}
                onClick={() => {
                  setPlatformChoice(item.id);
                  setEndpoint('');
                  setAttempted(false);
                  resetFeedback();
                }}
              >
                <span className={styles.platformRadio} aria-hidden="true" />
                <span className={styles.platformText}>
                  <span className={styles.platformName}>
                    {t(item.nameKey)}
                    {item.preset && (
                      <span className={styles.platformTag}>{t('sms_service.config_preset')}</span>
                    )}
                  </span>
                  <span className={styles.platformSummary}>{t(item.summaryKey)}</span>
                </span>
              </button>
            );
          })}
        </div>
      ),
    });
  }

  sections.push({
    key: 'natures',
    label: t('sms_service.config_step_natures'),
    body:
      kind === 'email' ? (
        <>
          {/* 二选一：同一个信箱只有一种凭据，所以画成单选。 */}
          <div className={styles.natureCards}>
            {allowed.map(({ nature }) => (
              <label className={styles.natureCard} key={nature}>
                <input
                  type="radio"
                  name="sms-email-nature"
                  checked={chosenNatures.has(nature)}
                  onChange={() => chooseEmailNature(nature)}
                />
                <span>{t(NATURE_LABEL[nature])}</span>
              </label>
            ))}
          </div>
          <div className={styles.blockLead}>{t('sms_service.config_email_nature_note')}</div>
        </>
      ) : (
        <>
          <div className={styles.natureCards}>
            {allowed.map(({ nature }) => (
              <label className={styles.natureCard} key={nature}>
                <input
                  type="checkbox"
                  checked={chosenNatures.has(nature)}
                  onChange={() => toggleNature(nature)}
                />
                <span>{t(NATURE_LABEL[nature])}</span>
              </label>
            ))}
          </div>
          {naturesMissing && (
            <div className={styles.fieldNoteWarn}>{t('sms_service.source_err_no_kind')}</div>
          )}
        </>
      ),
  });

  // 一种接入方式都没勾时，不留一个空的「连接信息」段。
  if (selected.length > 0) {
    sections.push({
      key: 'connection',
      label: t('sms_service.config_step_connection'),
      body: <>{selected.map((item) => connectionBlock(item.nature))}</>,
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={draft.id ? t('sms_service.config_edit') : t('sms_service.config_add')}
      footer={
        <div className={styles.footer}>
          <div className={styles.footerStatus} role="status" aria-live="polite">
            {gatePhase === 'locked' && (
              <span className={styles.noticeWarn}>
                <IconAlertTriangle size={14} />
                {t('sms_service.config_gate_locked_hint')}
              </span>
            )}
            {gatePhase !== 'locked' && error && (
              <span className={styles.noticeWarn}>
                <IconAlertTriangle size={14} />
                {error}
              </span>
            )}
          </div>
          <div className={styles.footerActions}>
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('sms_service.config_cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={saving || gatePhase === 'locked'}
            >
              {saving ? t('sms_service.config_saving') : t('sms_service.config_save')}
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.body}>
        {sections.map((section, index) => (
          <section className={styles.section} key={section.key}>
            <div className={styles.sectionLabel}>
              {STEP_MARKS[index]} {section.label}
            </div>
            {section.body}
          </section>
        ))}
      </div>
    </Modal>
  );
}
