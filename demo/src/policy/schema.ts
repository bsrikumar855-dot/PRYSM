import { z } from 'zod';

// DEMO-ONLY (TODO(T-001)): a deliberately small, deterministic rule language for the hackathon. It is not the
// CEL-based policy language of ADR-0005; there is no regex, no arithmetic and no clock, so a decision is a pure
// function of the policy and the tool call.

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

const scalar = z.union([z.string(), z.number(), z.boolean()]);

/** Comparison operators. Numeric ones never coerce: a string "9000" is not a number. */
export const OPERATORS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'exists'] as const;
export type Operator = (typeof OPERATORS)[number];

export const predicateSchema = z
  .strictObject({
    path: z
      .string()
      .regex(PATH, 'path must be dotted identifiers like amount_inr or order.id')
      .refine(
        (p) => !p.split('.').some((s) => FORBIDDEN_SEGMENTS.has(s)),
        'path may not use __proto__, constructor or prototype',
      ),
    op: z.enum(OPERATORS),
    value: z.union([scalar, z.array(scalar)]).optional(),
  })
  .superRefine((p, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message, path: ['value'] });
    };
    if (p.op === 'exists') {
      if (p.value !== undefined) issue('exists takes no value');
    } else if (p.op === 'in' || p.op === 'not_in') {
      if (!Array.isArray(p.value) || p.value.length === 0) issue(`${p.op} needs a non-empty list`);
    } else if (p.op === 'eq' || p.op === 'neq') {
      if (p.value === undefined || Array.isArray(p.value)) issue(`${p.op} needs one string, number or boolean`);
    } else if (typeof p.value !== 'number') {
      issue(`${p.op} needs a number`);
    }
  });
export type Predicate = z.infer<typeof predicateSchema>;

export const DECISIONS = ['allow', 'deny', 'require_approval'] as const;
export type RuleDecision = (typeof DECISIONS)[number];

export const ruleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'rule id must be lower-case letters, digits and hyphens'),
  /** Where the rule comes from. Supplied by the operator in the policy file; never invented by the code. */
  source: z.string().trim().min(1, 'every rule must cite a source'),
  description: z.string().trim().min(1).optional(),
  tool: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/, 'tool names are letters, digits, _ . -'),
  /** All predicates must hold (AND). For OR, write two rules. */
  when: z.array(predicateSchema).max(16).default([]),
  decision: z.enum(DECISIONS),
});
export type Rule = z.infer<typeof ruleSchema>;

/**
 * A policy file. There is no `default_decision` key on purpose: a tool call that no rule allows, denies or sends
 * for approval is denied (default deny). The strict object rejects unknown keys, so the default cannot be changed.
 */
export const policySchema = z
  .strictObject({
    version: z.literal(1),
    name: z.string().trim().min(1).optional(),
    rules: z.array(ruleSchema).min(1).max(500),
  })
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    policy.rules.forEach((rule, index) => {
      if (seen.has(rule.id))
        ctx.addIssue({ code: 'custom', message: `duplicate rule id "${rule.id}"`, path: ['rules', index, 'id'] });
      seen.add(rule.id);
    });
  });
export type Policy = z.infer<typeof policySchema>;
