# Security policy

Please report vulnerabilities privately through GitHub: **Security** tab, **Report a vulnerability**. Do not open a
public issue or pull request for a security problem.

Include the contract and network, what an attacker can do, and the steps or a test that shows it. We confirm receipt
within 72 hours and keep you informed until the issue is fixed.

In scope: the contracts in this repository and their deployments listed in [DEPLOYMENTS.md](DEPLOYMENTS.md).
Administrative actions on LitVM go through the 2-of-3 Safe `0x868b8B48db5DDE602D24960A606A5A8F93333bf9`. Since
2026-10-25 upgrades and ownership sit behind the 48-hour timelock `0x35774e0172571314fcDa7d602ea4D3410EE37188`: the
Safe proposes and executes, and a guardian can cancel during the delay.
