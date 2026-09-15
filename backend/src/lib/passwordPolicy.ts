/**
 * Password policy for Harvestlink registration / password changes.
 * Enforces minimum length and rejects passwords from a common-password denylist.
 */
import { AppError } from "./errors.js";

/** Minimum password length for new / changed passwords. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Common passwords (lowercase) — truncated top list used as a denylist.
 * Intentionally small and local so registration does not call an external API.
 */
const COMMON_PASSWORDS = new Set(
  [
    "password",
    "password1",
    "password12",
    "password123",
    "123456",
    "12345678",
    "123456789",
    "1234567890",
    "qwerty",
    "qwerty123",
    "abc123",
    "letmein",
    "welcome",
    "admin",
    "admin123",
    "administrator",
    "iloveyou",
    "monkey",
    "dragon",
    "master",
    "login",
    "princess",
    "football",
    "baseball",
    "soccer",
    "charlie",
    "aa123456",
    "donald",
    "password!",
    "passw0rd",
    "changeme",
    "changeme123",
    "harvestlink",
    "harvestlink123",
    "changemeadmin123!",
    "changemestore123!",
    "changemecashier123!",
    "secret",
    "secret123",
    "trustno1",
    "sunshine",
    "shadow",
    "superman",
    "batman",
    "access",
    "hello",
    "hello123",
    "freedom",
    "whatever",
    "qazwsx",
    "michael",
    "jennifer",
    "hunter",
    "buster",
    "soccer123",
    "hockey",
    "ranger",
    "jordan",
    "harley",
    "robert",
    "matthew",
    "andrew",
    "bailey",
    "pass1234",
    "1q2w3e4r",
    "1qaz2wsx",
    "zaq12wsx",
    "qwertyuiop",
    "asdfghjkl",
    "zxcvbnm",
    "111111",
    "000000",
    "666666",
    "888888",
    "654321",
    "7777777",
    "121212",
    "123123",
    "1234",
    "12345",
    "test",
    "test123",
    "testing",
    "guest",
    "root",
    "toor",
    "pass",
    "pass123",
    "p@ssw0rd",
    "p@ssword",
    "welcome1",
    "welcome123",
    "winter",
    "summer",
    "spring",
    "autumn",
    "lovely",
    "flower",
    "starwars",
    "startrek",
    "pokemon",
    "minecraft",
    "computer",
    "internet",
    "whatever1",
    "killer",
    "pepper",
    "cheese",
    "cookie",
    "maggie",
    "ginger",
    "pepper123",
  ].map((p) => p.toLowerCase()),
);

/**
 * Validates a candidate password. Throws AppError(400) on failure.
 */
export function assertPasswordPolicy(password: string): void {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(
      400,
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new AppError(400, "Password is too common; choose a stronger password");
  }
}
