import { makeSecretProviderDefinitionRegistry } from "@s8code/secret-provider-core/shared/definition";
import * as OnePassword from "@s8code/secret-provider-onepassword/shared/definition";

export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([
  OnePassword.definition,
]);
