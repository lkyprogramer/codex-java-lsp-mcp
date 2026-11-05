package lab.pagination;

public class FrozenPaginationTest {
  public static void main(String[] args) {
    PageWindow w=new PageWindow();if(w.offset(100000,100000)!=9999900000L)throw new AssertionError("overflow");
    if(w.offset(1,25)!=0||w.offset(2,25)!=25)throw new AssertionError("small pages");
    if(w.offset(Integer.MAX_VALUE,2)!=4294967292L)throw new AssertionError("int max");
    boolean fail=false;try{w.offset(0,1);}catch(IllegalArgumentException e){fail=true;}if(!fail)throw new AssertionError("validation");
  }
}
