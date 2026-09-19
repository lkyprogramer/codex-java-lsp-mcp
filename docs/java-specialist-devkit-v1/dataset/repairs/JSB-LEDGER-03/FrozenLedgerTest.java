package lab.ledger;

public class FrozenLedgerTest {
  public static void main(String[] args) {
    Ledger l=new Ledger();boolean rejected=false;try{l.transfer(-1);}catch(IllegalArgumentException e){rejected=true;}
    if(!rejected||l.debit()!=100||l.credit()!=0)throw new AssertionError("negative transfer");
    l.transfer(20);if(l.debit()!=80||l.credit()!=20)throw new AssertionError("normal transfer");
    rejected=false;try{l.transfer(81);}catch(IllegalArgumentException e){rejected=true;}
    if(!rejected||l.debit()!=80)throw new AssertionError("insufficient funds");
  }
}
