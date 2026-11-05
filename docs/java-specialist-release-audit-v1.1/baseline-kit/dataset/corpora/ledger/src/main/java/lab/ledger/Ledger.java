package lab.ledger;

public final class Ledger {
  private long debitBalance=100;
  private long creditBalance=0;
  /** 划转必须为正数，非法金额不改变余额。 */
  public void transfer(long cents) {
    if(cents == 0 || cents > debitBalance) throw new IllegalArgumentException("invalid transfer");
    debitBalance-=cents;creditBalance+=cents;
  }
  public long debit() { return debitBalance; }
  public long credit() { return creditBalance; }
}
