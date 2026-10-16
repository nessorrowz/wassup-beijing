import {
  formatRupiah,
  negateMoney,
  parseRupiah,
  subMoney,
  sumMoney,
  toMoney,
  type Money,
} from '../domain/money';
import type { AuditEntry, Earmark, Invoice } from '../domain/schemas';
import { addDays, addMonths, daysBetween, isBefore, type IsoDate } from '../domain/time';
import type { ActionService, ProposalPort } from '../actions/service';
import { lookupAction, type ActionName } from '../actions/registry';
import {
  FORECAST_HORIZON_DAYS,
  NON_VARIABLE_CATEGORIES,
  buildForecastInputs,
  computeRunway,
  projectForecast,
  runScenario,
  type ForecastInputs,
  type ForecastInvoice,
  type Scenario,
} from '../forecast';
import type { LedgerInput, LedgerSnapshot } from '../ledger/engine';
import {
  LOW_CONFIDENCE_THRESHOLD,
  assessCoverage,
  comparePolicies,
  type CoverageAssessment,
  type LoadedPolicy,
  type PolicyComparison,
} from '../policy';
import type { AgentTool, ToolContext, ToolDescriptor, ToolResult } from './types';

/**
 * The tools the model may call (PRD Section 7).
 *
 * T0 and T1 tools run directly: they read the ledger or produce text, and they
 * cannot change anything (ACT-2). T2 and T3 tools do not execute; they only ask
 * the tier engine for a pending proposal. There is no tool that approves or
 * executes, which is what keeps the model out of the approval path.
 *
 * Every number a tool returns was computed by the ledger, forecast or coverage
 * engine. The model reads these results; it never does the arithmetic (CHAT-1).
 */
export interface AgentToolDeps {
  /** The only part of the action service the agent ever receives. */
  proposals: ProposalPort;
  actions: Pick<ActionService, 'snapshot' | 'ledgerInput' | 'staleness'>;
  /** Read-only view of the stored policies. */
  policies: { all(): Promise<LoadedPolicy[]> };
  /** Read-only view of the audit log, used to find what "undo that" refers to. */
  auditEntries: () => Promise<AuditEntry[]>;
}

export interface AgentTools {
  descriptors(): ToolDescriptor[];
  invoke(name: string, args: unknown, context: ToolContext): Promise<ToolResult>;
}

/* ------------------------------------------------------------- result shapes */

export interface SummaryData {
  asOf: IsoDate;
  totalBalance: Money;
  freeCash: Money;
  safeToSpend: Money;
  obligationsDueIn30Days: Money;
  accounts: Array<{ id: string; name: string; type: string; balance: Money }>;
  activeEarmarks: Array<Pick<Earmark, 'id' | 'label' | 'amount' | 'reviewDate'>>;
  openInvoices: Array<{ id: string; client: string; amount: Money; dueDate: IsoDate; daysOverdue: number }>;
  dataIsStale: boolean;
}

export interface ForecastInputSummary {
  asOf: IsoDate;
  startingBalance: Money;
  activeEarmarkTotal: Money;
  freeCash: Money;
  obligations: Array<{ label: string; amount: Money; recurrence: string }>;
  countedInvoices: Array<{ id: string; client: string; amount: Money; expectedOn: IsoDate }>;
  countedInvoiceTotal: Money;
  /** Overdue invoices: left out, because their payment date is unknown. */
  excludedInvoices: Array<{ id: string; client: string; amount: Money; dueDate: IsoDate }>;
  excludedInvoiceTotal: Money;
  variableSpend: { windowDays: number; total: Money };
}

export interface RunwayData {
  label: string;
  asOf: IsoDate;
  runwayDays: number;
  runwayMonths: number;
  capped: boolean;
  depletionDate: IsoDate | null;
  horizonDays: number;
  lowestFreeCash: { date: IsoDate; amount: Money };
  firstShortfallDate: IsoDate | null;
  inputs: ForecastInputSummary;
}

export interface ScenarioData {
  label: string;
  asOf: IsoDate;
  base: { runwayDays: number; runwayMonths: number; depletionDate: IsoDate | null; capped: boolean };
  scenario: { runwayDays: number; runwayMonths: number; depletionDate: IsoDate | null; capped: boolean };
  runwayDeltaDays: number;
  horizonDays: number;
  lowestFreeCash: { base: { date: IsoDate; amount: Money }; scenario: { date: IsoDate; amount: Money } };
  /**
   * Scenario minus base for the pinch below, so a reply can state the change
   * without the model doing the subtraction (CHAT-1). Negative means less cash.
   */
  pinchChange: Money;
  /** Lowest free cash before the late money arrives, with and without the scenario. */
  pinch: {
    until: IsoDate;
    base: { date: IsoDate; amount: Money };
    scenario: { date: IsoDate; amount: Money };
  };
  affectedInvoices: Array<{
    id: string;
    client: string;
    amount: Money;
    dueDate: IsoDate;
    expectedOn: IsoDate;
  }>;
  daysLate: number | null;
  extraExpense: Money | null;
  notes: string[];
}

export type SpendingPeriod = 'this-month' | 'last-month' | 'last-30-days' | 'last-90-days';
export const SPENDING_PERIODS: readonly SpendingPeriod[] = [
  'this-month',
  'last-month',
  'last-30-days',
  'last-90-days',
];

export interface SpendingData {
  period: SpendingPeriod;
  from: IsoDate;
  to: IsoDate;
  moneyIn: Money;
  moneyOut: Money;
  net: Money;
  byCategory: Array<{ category: string; total: Money }>;
}

export interface PolicySummary {
  policyId: string;
  displayName: string;
  type: string;
  insurer: string;
  startDate: IsoDate | null;
  benefits: Array<{
    benefit: string;
    limit: Money;
    deductible: Money;
    waitingPeriodDays: number;
    clauseRef: string;
    page: number;
    lowConfidence: boolean;
  }>;
  /** Number of instruction-like sentences found in the document (ST2). */
  injectionSignals: number;
}

export interface ReminderData {
  invoiceId: string;
  client: string;
  amount: Money;
  dueDate: IsoDate;
  daysOverdue: number;
  tone: string;
  draft: string;
  sent: false;
}

export type { CoverageAssessment, PolicyComparison };

/* ------------------------------------------------------------------ helpers */

function describe(name: ActionName, parameters: Record<string, string>): ToolDescriptor {
  const definition = lookupAction(name);
  if (!definition) throw new Error(`${name} is not in the action registry`);
  return { name, tier: definition.tier, description: definition.description, parameters };
}

function asRecord(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A positive whole-rupiah amount, from a number or a digits-only string. Nothing else is accepted. */
function optionalAmount(value: unknown): Money | null | 'invalid' {
  if (value === undefined || value === null || value === '' || value === 0) return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? toMoney(value) : 'invalid';
  if (typeof value === 'string') {
    const parsed = parseRupiah(value.replace(/[.,\s]/g, ''));
    return parsed.ok && parsed.value > 0 ? parsed.value : 'invalid';
  }
  return 'invalid';
}

function summariseInputs(inputs: ForecastInputs, scenario: Scenario | null): ForecastInputSummary {
  const forecast = projectForecast(inputs, FORECAST_HORIZON_DAYS, scenario);
  const counted = forecast.events.filter((event) => event.kind === 'invoice');
  return {
    asOf: inputs.asOf,
    startingBalance: inputs.startingBalance,
    activeEarmarkTotal: inputs.activeEarmarkTotal,
    freeCash: toMoney(inputs.startingBalance - inputs.activeEarmarkTotal),
    obligations: inputs.obligations.map((obligation) => ({
      label: obligation.label,
      amount: obligation.amount,
      recurrence: obligation.recurrence,
    })),
    countedInvoices: counted.map((event) => {
      const invoice = inputs.openInvoices.find((candidate) => candidate.id === event.refId);
      return { id: event.refId, client: invoice?.client ?? '', amount: event.amount, expectedOn: event.date };
    }),
    countedInvoiceTotal: sumMoney(counted.map((event) => event.amount)),
    excludedInvoices: forecast.excludedInvoices.map((invoice) => ({ ...invoice })),
    excludedInvoiceTotal: sumMoney(forecast.excludedInvoices.map((invoice) => invoice.amount)),
    variableSpend: inputs.variableSpend,
  };
}

function periodRange(period: SpendingPeriod, asOf: IsoDate): { from: IsoDate; to: IsoDate } {
  const monthStart: IsoDate = `${asOf.slice(0, 7)}-01`;
  switch (period) {
    case 'this-month':
      return { from: monthStart, to: asOf };
    case 'last-month':
      return { from: addMonths(monthStart, -1), to: addDays(monthStart, -1) };
    case 'last-30-days':
      return { from: addDays(asOf, -29), to: asOf };
    case 'last-90-days':
      return { from: addDays(asOf, -89), to: asOf };
  }
}

function summarisePolicy(loaded: LoadedPolicy): PolicySummary {
  return {
    policyId: loaded.policy.id,
    displayName: loaded.policy.displayName,
    type: loaded.policy.type,
    insurer: loaded.policy.insurer,
    startDate: loaded.policy.startDate,
    benefits: loaded.items.map((item) => ({
      benefit: item.benefit,
      limit: item.limit,
      deductible: item.deductible,
      waitingPeriodDays: item.waitingPeriodDays,
      clauseRef: item.clauseRef,
      page: item.page,
      lowConfidence: item.confidence < LOW_CONFIDENCE_THRESHOLD,
    })),
    injectionSignals: loaded.document.clauses.reduce(
      (count, clause) => count + clause.injectionSignals.length,
      0,
    ),
  };
}

/** Find a policy by id, by type ("health") or by a word from its name. */
function resolvePolicy(
  policies: readonly LoadedPolicy[],
  reference: string | null,
): { policy: LoadedPolicy } | { reason: string } {
  if (policies.length === 0) {
    return { reason: 'no policy is loaded yet; upload a policy PDF first' };
  }
  if (reference !== null) {
    const wanted = reference.toLowerCase();
    const byId = policies.find((candidate) => candidate.policy.id === reference);
    if (byId) return { policy: byId };
    const matches = policies.filter(
      (candidate) =>
        candidate.policy.type === wanted ||
        candidate.policy.displayName.toLowerCase().includes(wanted) ||
        wanted.includes(candidate.policy.type),
    );
    if (matches.length === 1) return { policy: matches[0]! };
  }
  if (policies.length === 1) return { policy: policies[0]! };
  return {
    reason: `which policy? ${policies.map((candidate) => `${candidate.policy.displayName} (${candidate.policy.id})`).join(' or ')}`,
  };
}

const REMINDER_TONES = ['friendly', 'firm'] as const;

function reminderDraft(invoice: Invoice, daysOverdue: number, tone: string): string {
  const amount = formatRupiah(invoice.amount);
  const lateness =
    daysOverdue > 0
      ? `was due on ${invoice.dueDate} and is now ${daysOverdue} days overdue`
      : `is due on ${invoice.dueDate}`;
  if (tone === 'firm') {
    return `Dear ${invoice.client}, invoice ${invoice.id} for ${amount} ${lateness}. Please arrange payment this week, or tell me today if there is a problem with the invoice. Thank you.`;
  }
  return `Hi ${invoice.client}, I hope you are well. A quick note that invoice ${invoice.id} for ${amount} ${lateness}. Could you let me know when I can expect payment? Thank you.`;
}

/* -------------------------------------------------------------------- tools */

export function createAgentTools(deps: AgentToolDeps): AgentTools {
  const tools = new Map<ActionName, AgentTool>();

  const register = (
    name: ActionName,
    parameters: Record<string, string>,
    invoke: AgentTool['invoke'],
  ): void => {
    tools.set(name, { descriptor: describe(name, parameters), invoke });
  };

  async function ledgerState(): Promise<{ ledger: LedgerInput; snapshot: LedgerSnapshot }> {
    const [ledger, snapshot] = await Promise.all([deps.actions.ledgerInput(), deps.actions.snapshot()]);
    return { ledger, snapshot };
  }

  register('get_summary', {}, async () => {
    const [{ ledger, snapshot }, staleness] = await Promise.all([ledgerState(), deps.actions.staleness()]);
    const data: SummaryData = {
      asOf: snapshot.asOf,
      totalBalance: snapshot.totalBalance,
      freeCash: snapshot.freeCash,
      safeToSpend: snapshot.safeToSpend,
      obligationsDueIn30Days: snapshot.obligationsDueIn30Days,
      accounts: ledger.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        balance: snapshot.balancesByAccount[account.id] ?? toMoney(0),
      })),
      activeEarmarks: ledger.earmarks
        .filter((earmark) => earmark.active)
        .map(({ id, label, amount, reviewDate }) => ({ id, label, amount, reviewDate })),
      openInvoices: ledger.invoices
        .filter((invoice) => invoice.paidDate === null)
        .map((invoice) => ({
          id: invoice.id,
          client: invoice.client,
          amount: invoice.amount,
          dueDate: invoice.dueDate,
          daysOverdue: Math.max(0, daysBetween(invoice.dueDate, snapshot.asOf)),
        })),
      dataIsStale: staleness.stale,
    };
    return { ok: true, tool: 'get_summary', data };
  });

  register('get_runway', {}, async () => {
    const { ledger, snapshot } = await ledgerState();
    const inputs = buildForecastInputs(ledger, snapshot);
    const runway = computeRunway(inputs);
    const forecast = projectForecast(inputs);
    const data: RunwayData = {
      label: runway.label,
      asOf: runway.asOf,
      runwayDays: runway.runwayDays,
      runwayMonths: runway.runwayMonths,
      capped: runway.capped,
      depletionDate: runway.depletionDate,
      horizonDays: forecast.horizonDays,
      lowestFreeCash: forecast.lowestFreeCash,
      firstShortfallDate: forecast.firstShortfallDate,
      inputs: summariseInputs(inputs, null),
    };
    return { ok: true, tool: 'get_runway', data };
  });

  register(
    'run_scenario',
    { invoiceId: 'string?', client: 'string?', daysLate: 'number?', extraExpense: 'number?' },
    async (args) => {
      const params = asRecord(args);
      const { ledger, snapshot } = await ledgerState();
      const inputs = buildForecastInputs(ledger, snapshot);
      const fail = (reason: string): ToolResult => ({ ok: false, tool: 'run_scenario', reason });

      const extraExpense = optionalAmount(params['extraExpense']);
      if (extraExpense === 'invalid') return fail('extraExpense must be a positive whole number of rupiah');

      const invoiceId = optionalString(params['invoiceId']);
      const client = optionalString(params['client']);
      const rawDays = params['daysLate'];
      const daysLate = rawDays === undefined || rawDays === null ? null : Number(rawDays);
      if (daysLate !== null && (!Number.isInteger(daysLate) || daysLate < 0 || daysLate > 365)) {
        return fail('daysLate must be a whole number of days between 0 and 365');
      }

      const notes: string[] = [];
      let invoices: ForecastInvoice[] = [];
      if (invoiceId !== null || client !== null) {
        invoices = inputs.openInvoices.filter((invoice) =>
          invoiceId !== null
            ? invoice.id === invoiceId
            : invoice.client.toLowerCase() === client!.toLowerCase(),
        );
        if (invoices.length === 0) {
          const known = [...new Set(inputs.openInvoices.map((invoice) => invoice.client))].join(', ');
          return fail(
            `there is no open invoice for ${invoiceId ?? client}. Clients with an open invoice: ${known || 'none'}`,
          );
        }
        if (daysLate === null)
          return fail('how many days late? daysLate is required with an invoice or a client');
      } else if (daysLate !== null) {
        return fail('which invoice or client? daysLate needs an invoiceId or a client');
      }

      if (invoices.length === 0 && extraExpense === null) {
        return fail('a scenario needs an invoice paid late, a one-off expense, or both');
      }

      const scenario: Scenario = {
        ...(invoices.length > 0 && daysLate !== null
          ? { invoiceLate: { invoiceIds: invoices.map((invoice) => invoice.id), daysLate } }
          : {}),
        ...(extraExpense !== null ? { extraExpense: { amount: extraExpense } } : {}),
      };

      for (const invoice of invoices) {
        if (isBefore(invoice.dueDate, snapshot.asOf)) {
          notes.push(`${invoice.id} is already overdue, so it is left out of both forecasts.`);
        }
      }

      const result = runScenario(inputs, scenario);
      const pick = (runway: typeof result.base) => ({
        runwayDays: runway.runwayDays,
        runwayMonths: runway.runwayMonths,
        depletionDate: runway.depletionDate,
        capped: runway.capped,
      });
      const data: ScenarioData = {
        label: result.label,
        asOf: snapshot.asOf,
        base: pick(result.base),
        scenario: pick(result.scenario),
        runwayDeltaDays: result.runwayDeltaDays,
        horizonDays: result.forecast.horizonDays,
        lowestFreeCash: { base: result.baseLowestFreeCash, scenario: result.forecast.lowestFreeCash },
        pinchChange: subMoney(result.pinch.scenario.amount, result.pinch.base.amount),
        pinch: result.pinch,
        affectedInvoices: invoices.map((invoice) => ({
          ...invoice,
          expectedOn: addDays(invoice.dueDate, daysLate ?? 0),
        })),
        daysLate: invoices.length > 0 ? daysLate : null,
        extraExpense,
        notes,
      };
      return { ok: true, tool: 'run_scenario', data };
    },
  );

  register('get_spending', { period: SPENDING_PERIODS.join(' | ') }, async (args) => {
    const requested = optionalString(asRecord(args)['period']) ?? 'this-month';
    if (!SPENDING_PERIODS.includes(requested as SpendingPeriod)) {
      return {
        ok: false,
        tool: 'get_spending',
        reason: `unknown period "${requested}"; use one of ${SPENDING_PERIODS.join(', ')}`,
      };
    }
    const period = requested as SpendingPeriod;
    const { ledger, snapshot } = await ledgerState();
    const { from, to } = periodRange(period, snapshot.asOf);

    // Moves between the user's own accounts are neither income nor spending.
    const transfers = NON_VARIABLE_CATEGORIES.filter((category) => category.includes('transfer'));
    const rows = ledger.transactions.filter(
      (transaction) =>
        !isBefore(transaction.date, from) &&
        !isBefore(to, transaction.date) &&
        !transfers.includes(transaction.category),
    );

    const totals = new Map<string, Money[]>();
    for (const row of rows.filter((candidate) => candidate.amount < 0)) {
      totals.set(row.category, [...(totals.get(row.category) ?? []), row.amount]);
    }

    const moneyIn = sumMoney(rows.filter((row) => row.amount > 0).map((row) => row.amount));
    const moneyOut = negateMoney(sumMoney(rows.filter((row) => row.amount < 0).map((row) => row.amount)));
    const data: SpendingData = {
      period,
      from,
      to,
      moneyIn,
      moneyOut,
      net: toMoney(moneyIn - moneyOut),
      byCategory: [...totals.entries()]
        .map(([category, amounts]) => ({ category, total: negateMoney(sumMoney(amounts)) }))
        .sort((a, b) => b.total - a.total || (a.category < b.category ? -1 : 1)),
    };
    return { ok: true, tool: 'get_spending', data };
  });

  register('list_policies', {}, async () => {
    const policies = await deps.policies.all();
    const data: PolicySummary[] = policies.map(summarisePolicy);
    return { ok: true, tool: 'list_policies', data };
  });

  register(
    'get_coverage',
    { policyId: 'string', event: 'string', estimatedCost: 'number?' },
    async (args) => {
      const params = asRecord(args);
      const event = optionalString(params['event']);
      if (event === null) {
        return { ok: false, tool: 'get_coverage', reason: 'which event? For example "hospital stay"' };
      }
      const estimatedCost = optionalAmount(params['estimatedCost']);
      if (estimatedCost === 'invalid') {
        return {
          ok: false,
          tool: 'get_coverage',
          reason: 'estimatedCost must be a positive whole number of rupiah',
        };
      }

      const resolved = resolvePolicy(await deps.policies.all(), optionalString(params['policyId']));
      if ('reason' in resolved) return { ok: false, tool: 'get_coverage', reason: resolved.reason };

      const snapshot = await deps.actions.snapshot();
      const data: CoverageAssessment = assessCoverage({
        policy: resolved.policy.policy,
        document: resolved.policy.document,
        items: resolved.policy.items,
        event,
        estimatedCost,
        freeCash: snapshot.freeCash,
        asOf: snapshot.asOf,
      });
      return { ok: true, tool: 'get_coverage', data };
    },
  );

  register('compare_policies', { policyIds: 'string[]?', criteria: 'string[]' }, async (args) => {
    const params = asRecord(args);
    const all = await deps.policies.all();
    const requested = Array.isArray(params['policyIds'])
      ? params['policyIds'].filter((value): value is string => typeof value === 'string')
      : [];

    let chosen = all;
    if (requested.length > 0) {
      chosen = [];
      for (const reference of requested) {
        const resolved = resolvePolicy(all, reference);
        if ('reason' in resolved) return { ok: false, tool: 'compare_policies', reason: resolved.reason };
        if (!chosen.includes(resolved.policy)) chosen.push(resolved.policy);
      }
    }
    if (chosen.length < 2) {
      return {
        ok: false,
        tool: 'compare_policies',
        reason: `a comparison needs two policies; ${all.length} loaded. Upload another policy PDF first`,
      };
    }

    const criteria = Array.isArray(params['criteria'])
      ? params['criteria'].filter((value): value is string => typeof value === 'string')
      : [];
    const data: PolicyComparison = comparePolicies(
      chosen.map((entry) => ({ policy: entry.policy, items: entry.items })),
      criteria,
    );
    return { ok: true, tool: 'compare_policies', data };
  });

  register('draft_reminder', { invoiceId: 'string?', tone: REMINDER_TONES.join(' | ') }, async (args) => {
    const params = asRecord(args);
    const { ledger, snapshot } = await ledgerState();
    const open = ledger.invoices.filter((candidate) => candidate.paidDate === null);
    const requested = optionalString(params['invoiceId']);

    // With no invoice named, the reminder is for the one that is most overdue.
    const invoice = requested
      ? open.find((candidate) => candidate.id === requested)
      : [...open]
          .filter((candidate) => isBefore(candidate.dueDate, snapshot.asOf))
          .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))[0];
    if (!invoice) {
      return {
        ok: false,
        tool: 'draft_reminder',
        reason: requested ? `there is no open invoice ${requested}` : 'there is no overdue invoice to chase',
      };
    }

    const tone = REMINDER_TONES.find((candidate) => candidate === params['tone']) ?? 'friendly';
    const daysOverdue = Math.max(0, daysBetween(invoice.dueDate, snapshot.asOf));
    // T1: text only. Nothing is sent and nothing changes (ACT-2).
    const data: ReminderData = {
      invoiceId: invoice.id,
      client: invoice.client,
      amount: invoice.amount,
      dueDate: invoice.dueDate,
      daysOverdue,
      tone,
      draft: reminderDraft(invoice, daysOverdue, tone),
      sent: false,
    };
    return { ok: true, tool: 'draft_reminder', data };
  });

  register(
    'earmark.create',
    { label: 'string', amount: 'number', reviewDate: 'YYYY-MM-DD' },
    (args, context) => propose('earmark.create', args, context),
  );

  register(
    'earmark.update',
    { earmarkId: 'string', label: 'string?', amount: 'number?', reviewDate: 'YYYY-MM-DD?' },
    (args, context) => propose('earmark.update', args, context),
  );

  register('earmark.delete', { earmarkId: 'string' }, (args, context) =>
    propose('earmark.delete', args, context),
  );

  register(
    'transaction.add',
    { accountId: 'string', date: 'YYYY-MM-DD', amount: 'number', merchant: 'string', category: 'string' },
    (args, context) => propose('transaction.add', args, context),
  );

  register('undo', { auditEntryId: 'string?' }, async (args, context) => {
    const params = asRecord(args);
    if (optionalString(params['auditEntryId']) !== null) return propose('undo', args, context);

    // "Undo that": the most recent executed action that has not been undone.
    const entries = await deps.auditEntries();
    const undone = new Set(
      entries.filter((entry) => entry.event === 'undone').map((entry) => entry.proposalId),
    );
    const last = [...entries]
      .reverse()
      .find((entry) => entry.event === 'executed' && !undone.has(entry.proposalId));
    if (!last) return { ok: false, tool: 'undo', reason: 'there is nothing to undo' };
    return propose('undo', { auditEntryId: last.id }, context);
  });

  register(
    'transfer',
    { fromAccountId: 'string', toAccountId: 'string', amount: 'number' },
    (args, context) => propose('transfer', args, context),
  );

  async function propose(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const result = await deps.proposals.propose({
      action: name,
      params: args,
      provenance: {
        requestedBy: context.requestedBy,
        untrustedInputs: context.untrustedInputs ?? [],
      },
      actor: 'agent',
    });

    if (result.kind === 'proposal') {
      // The agent gets the pending proposal, never a handle that could approve it.
      return {
        ok: true,
        tool: name as ActionName,
        data: { status: 'pending-approval', proposal: result.proposal },
      };
    }
    return { ok: false, tool: name, reason: result.reason };
  }

  return {
    descriptors: () => [...tools.values()].map((tool) => tool.descriptor),
    invoke: async (name, args, context) => {
      const tool = lookupAction(name) ? tools.get(name as ActionName) : undefined;
      if (!tool) {
        // A name outside the registry (or a registered action with no tool, such
        // as statement.import) goes to the tier engine, which refuses it and
        // writes the refusal to the audit log (ACT-1).
        if (lookupAction(name)) {
          return { ok: false, tool: name, reason: `"${name}" cannot be requested from chat` };
        }
        return propose(name, args, context);
      }
      return tool.invoke(args, context);
    },
  };
}
