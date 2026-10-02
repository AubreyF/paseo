# Transparent HTTPS credential mediation

Status: deferred research project, not part of the first credential connector.

Determine whether unchanged developer tools can use protected credentials through a host-controlled proxy without giving guests equivalent unrestricted authority. Investigate TLS trust, certificate pinning, redirects, streaming, request signing, credential scope, and bypass paths before choosing an implementation.

Produce a supported-tool matrix and a threat model. Do not equate hiding a token with limiting its use. Prefer typed connector operations when arbitrary HTTP requests would recreate the token's full authority.

Acceptance for a prototype: credential secrecy, destination and operation enforcement, redirect/replay tests, safe failures, and explicit unsupported clients. Depends on the credential broker's identity and approval contract, but its research can proceed independently. No delivery estimate until compatibility is measured.
