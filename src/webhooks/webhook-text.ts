const CONTROL_CHARACTERS_PATTERN = /\p{Cc}/gu;
const MAX_FAILURE_REASON_LENGTH = 200;

const storableText = (text: string, maxLength: number): string =>
  text.replace(CONTROL_CHARACTERS_PATTERN, '').slice(0, maxLength);

export { MAX_FAILURE_REASON_LENGTH, storableText };
