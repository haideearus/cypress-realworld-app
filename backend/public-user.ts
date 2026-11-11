import { User } from "../src/models/user";

export function publicUser(user: User): Omit<User, "password"> {
  const { password: _password, ...visible } = user;
  return visible;
}
