package example;
public class UnicodeService {
    public static final String ICON = "😀"; public String 标题() { return ICON + "订单"; }
    /** 查询已取消订单，保留原始中文说明。 */
    public String cancelledTitle() { return "已取消"; }
}
