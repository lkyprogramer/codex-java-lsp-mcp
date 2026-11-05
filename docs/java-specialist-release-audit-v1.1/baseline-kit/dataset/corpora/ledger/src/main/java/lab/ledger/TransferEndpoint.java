package lab.ledger;

public final class TransferEndpoint {
  private final Ledger ledger;
  public TransferEndpoint(Ledger ledger) { this.ledger=ledger; }
  public void submit(TransferCommand command) { ledger.transfer(command.cents); }
}
