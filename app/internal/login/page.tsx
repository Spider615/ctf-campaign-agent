import { Suspense } from "react";

import { LoginForm } from "../../components/internal/login-form";

export default function InternalLoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
