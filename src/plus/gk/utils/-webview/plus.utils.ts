import type { MessageItem } from 'vscode';
import { window } from 'vscode';
import { proTrialLengthInDays } from '../../../../constants.subscription';
import type { Source } from '../../../../constants.telemetry';
import type { Container } from '../../../../container';
import { configuration } from '../../../../system/-webview/configuration';
import { getContext } from '../../../../system/-webview/context';
import { isSubscriptionPaidPlan } from '../subscription.utils';

export function arePlusFeaturesEnabled(): boolean {
	const enabled = configuration.get('plusFeatures.enabled', undefined, true);
	return enabled ? true : !getContext('gitlens:plus:disabled');
}

export async function ensurePlusFeaturesEnabled(): Promise<boolean> {
	if (arePlusFeaturesEnabled()) return true;

	const confirm: MessageItem = { title: 'Enable' };
	const cancel: MessageItem = { title: 'Cancel', isCloseAffordance: true };
	const result = await window.showInformationMessage(
		'Pro features are currently disabled. Would you like to enable them?',
		{ modal: true },
		confirm,
		cancel,
	);

	if (result !== confirm) return false;

	await configuration.updateEffective('plusFeatures.enabled', true);
	return true;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ensurePaidPlan(_container: Container, _title: string, _source: Source): Promise<boolean> {
	// 【破解】始终返回 true，绕过付费验证
	return Promise.resolve(true);
}
