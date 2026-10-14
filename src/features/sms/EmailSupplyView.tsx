/**
 * 邮箱接码视图（「接码服务」页的「邮箱」类别）。
 *
 * 版面与手机号一侧**同一套骨架**：来源（渠道）→ 池。区别只在**性质**：邮箱这里
 * 可选的是「API 服务」与「邮箱（IMAP）」—— 一个邮箱账号可以承接多个收件地址
 * （多个自建域 catch-all 转发进来），所以取码要按收件地址匹配。
 *
 * 规矩同手机号一侧：凭据的值永不出现在页面上，只出现凭据的名字和「有没有存」；
 * 没有数据就是空态，不编造域名、地址或收件箱。
 */

import styles from './SmsServicePage.module.scss';
import { SupplyChannelCard } from './SupplyChannelCard';
import { SupplyPoolCard } from './SupplyPoolCard';

export function EmailSupplyView() {
  return (
    <div className={styles.page}>
      <SupplyChannelCard kind="email" />
      <SupplyPoolCard kind="email" />
    </div>
  );
}
