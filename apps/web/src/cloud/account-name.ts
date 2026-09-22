/** HTML pattern attribute. Chrome compiles these with the unicode-sets flag, which rejects an unescaped hyphen. */
export const accountNamePattern = String.raw`[A-Za-z0-9][A-Za-z0-9._\-]{2,31}`;
