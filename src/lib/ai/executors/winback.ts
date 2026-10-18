import { registerExecutor } from '../actions';
import { executeCampaign, prepareCampaign } from '../winbackCampaign';

/**
 * `winback.campaign`: листи повернення клієнтам від ІІ (scope `messaging`).
 *
 * Режим OFF/ASK/AUTO бере actions.ts з політики власника; тут тільки доменна
 * частина. prepare перевіряє клієнтів і тексти й будує підсумок кодом; execute
 * або відправляє (у денному вікні), або ставить у чергу до вікна — result несе
 * статус кожного адресата, його дописує планувальник (winbackCampaign.ts).
 *
 * Правила листа (згода, ліміти, лічильник, вікно) — ті самі, що в шаблонного
 * повернення, див. winback.ts: тут вони не дублюються, а викликаються.
 */
registerExecutor('winback.campaign', {
  scope: 'messaging',
  prepare: (clubId, raw) => prepareCampaign(clubId, raw),
  execute: (clubId, raw) => executeCampaign(clubId, raw),
});
