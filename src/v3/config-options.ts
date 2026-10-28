/** Readers over the `configOptions` V3 returns from `session/new`,
 * `session/load` and every `config_option_update`. Pure: the session caches the
 * latest array and these answer questions about it. */

interface Choice {
  value: string;
  name?: string;
  /** `_meta.kiro.effortLevels` on a model option: the levels its selection
   * accepts. Absent (or `hasEffort: false`) means the model has no effort. */
  effortLevels: string[];
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

function optionOf(all: unknown, id: string): Record<string, any> | undefined {
  if (!Array.isArray(all)) return undefined;
  return all
    .map(asRecord)
    .find((option): option is Record<string, any> => option?.id === id);
}

/** Values a select offers, in kiro's order. Empty when the option is absent —
 * V3 drops `effortLevel` entirely for a model without effort support. */
export function configOptionChoices(all: unknown, id: string): Choice[] {
  const options = optionOf(all, id)?.options;
  if (!Array.isArray(options)) return [];
  return options
    .map(asRecord)
    .filter((choice): choice is Record<string, any> => !!choice)
    .filter((choice) => typeof choice.value === 'string' && choice.value)
    .map((choice) => {
      const levels = asRecord(choice._meta?.kiro)?.effortLevels;
      return {
        value: choice.value as string,
        name: typeof choice.name === 'string' ? choice.name : undefined,
        effortLevels: Array.isArray(levels)
          ? levels.filter((level): level is string => typeof level === 'string')
          : [],
      };
    });
}

export function configOptionValues(all: unknown, id: string): string[] {
  return configOptionChoices(all, id).map((choice) => choice.value);
}

/** The value kiro reports as applied — set_config_option echoes it, which is
 * the only confirmation available: an unusable value is not an error. */
export function configOptionCurrentValue(
  all: unknown,
  id: string,
): string | null {
  const value = optionOf(all, id)?.currentValue;
  return typeof value === 'string' ? value : null;
}

/** Effort levels the given model advertises. Empty when the model has none, so
 * callers skip the effortLevel write instead of sending an ignored value. */
export function modelEffortLevels(all: unknown, modelValue: string): string[] {
  return (
    configOptionChoices(all, 'model').find(
      (choice) => choice.value === modelValue,
    )?.effortLevels ?? []
  );
}
